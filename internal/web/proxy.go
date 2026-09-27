package web

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

const maxBody = 1 << 20
const maxResponse = 4 << 20

func (s *Server) proxyAPI(w http.ResponseWriter, r *http.Request) {
	path := "/api/v1/" + strings.TrimPrefix(r.URL.Path, "/api/laso/")
	path += querySuffix(r.URL.RawQuery)
	stream := strings.HasSuffix(path, "/events/stream")
	if err := validateRoute(r.Method, path, stream); err != nil {
		s.writeJSON(w, http.StatusNotFound, map[string]string{"error": "LASO API operation is not available in this adapter"})
		return
	}
	var body io.Reader
	if r.Method == http.MethodPost {
		if r.Body == nil {
			s.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Request body is required"})
			return
		}
		if r.ContentLength > maxBody {
			s.writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "Request body exceeds 1 MiB"})
			return
		}
		limited := http.MaxBytesReader(w, r.Body, maxBody)
		defer limited.Close()
		bytes, err := io.ReadAll(limited)
		var object map[string]any
		if err != nil || json.Unmarshal(bytes, &object) != nil || object == nil {
			s.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Request body must be a JSON object under 1 MiB"})
			return
		}
		body = strings.NewReader(string(bytes))
	}
	ctx := r.Context()
	upstreamRequest, err := http.NewRequestWithContext(ctx, r.Method, s.config.LASOURL+path, body)
	if err != nil {
		s.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid LASO request"})
		return
	}
	upstreamRequest.Header.Set("Accept", "application/json")
	upstreamRequest.Header.Set("User-Agent", "LASO-Web/Go")
	if r.Method == http.MethodPost {
		upstreamRequest.Header.Set("Content-Type", "application/json")
	}
	if stream {
		upstreamRequest.Header.Set("Accept", "text/event-stream")
		if cursor := r.Header.Get("Last-Event-ID"); cursor != "" {
			upstreamRequest.Header.Set("Last-Event-ID", cursor)
		}
		upstreamRequest.Header.Set("Cache-Control", "no-cache")
	}
	if s.config.Token != "" {
		upstreamRequest.Header.Set("Authorization", "Bearer "+s.config.Token)
	}
	client := s.client
	if stream {
		client = &http.Client{Transport: s.stream, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(upstreamRequest)
	if err != nil {
		s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Cannot contact LASO", "detail": "LASO API is unreachable or timed out"})
		return
	}
	defer response.Body.Close()
	if stream && response.StatusCode == http.StatusOK && strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(response.StatusCode)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		_, _ = io.Copy(flushWriter{w: w}, response.Body)
		return
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil || len(data) > maxResponse {
		s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LASO response is unavailable or exceeds 4 MiB"})
		return
	}
	var value any
	if json.Unmarshal(data, &value) != nil {
		s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LASO returned malformed JSON"})
		return
	}
	if _, object := value.(map[string]any); !object {
		if _, array := value.([]any); !array {
			s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LASO returned an unexpected response shape"})
			return
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if retry := response.Header.Get("Retry-After"); retry != "" && stream {
		w.Header().Set("Retry-After", retry)
	}
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(data)
}

type flushWriter struct{ w http.ResponseWriter }

func (f flushWriter) Write(p []byte) (int, error) {
	n, err := f.w.Write(p)
	if flusher, ok := f.w.(http.Flusher); ok {
		flusher.Flush()
	}
	return n, err
}

func querySuffix(raw string) string {
	if raw == "" {
		return ""
	}
	return "?" + raw
}
