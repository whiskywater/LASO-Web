package web

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const maxBody = 1 << 20
const maxResponse = 4 << 20

var (
	identifier = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,128}$`)
)

type Server struct {
	config Config
	assets fs.FS
	client *http.Client
	stream *http.Transport
	slots  chan struct{}
}

func NewServer(config Config, assets fs.FS) *Server {
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment, MaxIdleConns: 32, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 8 * time.Second}
	return &Server{config: config, assets: assets, client: &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, stream: transport, slots: make(chan struct{}, 32)}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		s.writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "LASO-Web is at request capacity"})
		return
	}
	if _, ok := s.config.AllowedHosts[strings.ToLower(r.Host)]; !ok {
		s.writeJSON(w, http.StatusMisdirectedRequest, map[string]string{"error": "Host is not allowed"})
		return
	}
	if !s.authorized(r) {
		w.Header().Set("WWW-Authenticate", `Basic realm="LASO-Web", charset="UTF-8"`)
		s.writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return
	}
	if r.Method == http.MethodPost {
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(u.Host, r.Host) || u.Scheme == "" {
				s.writeJSON(w, http.StatusForbidden, map[string]string{"error": "Cross-origin state changes are not allowed"})
				return
			}
		}
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			s.writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "Content-Type must be application/json"})
			return
		}
	}
	s.securityHeaders(w)
	if r.URL.Path == "/" && r.Method == http.MethodGet {
		s.serveAsset(w, "index.html")
		return
	}
	if r.URL.Path == "/sessions/new" && r.Method == http.MethodGet {
		s.serveAsset(w, "session.html")
		return
	}
	if strings.HasPrefix(r.URL.Path, "/sessions/") && r.Method == http.MethodGet {
		id := strings.TrimPrefix(r.URL.Path, "/sessions/")
		if identifier.MatchString(id) {
			s.serveAsset(w, "session.html")
			return
		}
	}
	if r.Method == http.MethodGet && (r.URL.Path == "/app.js" || r.URL.Path == "/model.js" || r.URL.Path == "/style.css" || r.URL.Path == "/sessions.js" || r.URL.Path == "/session-model.js" || r.URL.Path == "/session.js" || r.URL.Path == "/session.css" || r.URL.Path == "/session-mobile.css") {
		s.serveAsset(w, strings.TrimPrefix(r.URL.Path, "/"))
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/laso/") {
		s.proxyAPI(w, r)
		return
	}
	http.NotFound(w, r)
}

func (s *Server) authorized(r *http.Request) bool {
	if s.config.Password == "" {
		return true
	}
	user, password, ok := r.BasicAuth()
	if !ok || subtle.ConstantTimeCompare([]byte(user), []byte("operator")) != 1 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(password), []byte(s.config.Password)) == 1
}

func (s *Server) securityHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'")
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, value any) {
	s.securityHeaders(w)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func (s *Server) serveAsset(w http.ResponseWriter, name string) {
	content, err := fs.ReadFile(s.assets, name)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	switch {
	case strings.HasSuffix(name, ".html"):
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
	case strings.HasSuffix(name, ".js"):
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	case strings.HasSuffix(name, ".css"):
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
	}
	w.Header().Set("Content-Length", strconv.Itoa(len(content)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

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

func validateRoute(method, path string, stream bool) error {
	if len(path) > 512 || !strings.HasPrefix(path, "/api/v1/") {
		return context.Canceled
	}
	base, query, hasQuery := strings.Cut(path, "?")
	if hasQuery {
		if method != http.MethodGet || !validQuery(base, query) {
			return context.Canceled
		}
		path = base
	}
	if method == http.MethodGet && (base == "/api/v1/health" || base == "/api/v1/version" || base == "/api/v1/sessions" || base == "/api/v1/runs" || base == "/api/v1/pipelines" || base == "/api/v1/workers" || base == "/api/v1/worker-jobs" || base == "/api/v1/approvals" || base == "/api/v1/schedules" || base == "/api/v1/worker-requests") {
		return nil
	}
	if stream {
		parts := strings.Split(strings.TrimPrefix(base, "/api/v1/sessions/"), "/")
		if method == http.MethodGet && len(parts) == 3 && identifier.MatchString(parts[0]) && parts[1] == "events" && parts[2] == "stream" {
			return nil
		}
	}
	if strings.HasPrefix(base, "/api/v1/sessions/") {
		parts := strings.Split(strings.TrimPrefix(base, "/api/v1/sessions/"), "/")
		if len(parts) == 1 && identifier.MatchString(parts[0]) && method == http.MethodGet {
			return nil
		}
		if len(parts) == 2 && identifier.MatchString(parts[0]) && ((parts[1] == "turns" && (method == http.MethodGet || method == http.MethodPost)) || (parts[1] == "events" && method == http.MethodGet) || (parts[1] == "close" && method == http.MethodPost)) {
			return nil
		}
	}
	if method == http.MethodPost && (base == "/api/v1/sessions" || base == "/api/v1/pipelines") {
		return nil
	}
	if method == http.MethodGet {
		parts := strings.Split(strings.TrimPrefix(base, "/api/v1/"), "/")
		collections := map[string]map[string]bool{"runs": {"": true, "messages": true, "events": true, "attempts": true}, "pipelines": {"": true}, "workers": {"": true}, "approvals": {"": true}, "schedules": {"": true}, "worker-jobs": {"": true}, "worker-requests": {"": true}}
		if len(parts) == 2 && identifier.MatchString(parts[1]) && collections[parts[0]][""] {
			return nil
		}
		if len(parts) == 3 && identifier.MatchString(parts[1]) && collections[parts[0]][parts[2]] {
			return nil
		}
	}
	if method == http.MethodPost {
		parts := strings.Split(strings.TrimPrefix(base, "/api/v1/"), "/")
		allowed := map[string]map[string]bool{"pipelines": {"runs": true}, "runs": {"cancel": true, "resume": true}, "approvals": {"approve": true, "reject": true}, "schedules": {"enable": true, "disable": true}, "worker-jobs": {"cancel": true}, "worker-requests": {"respond": true, "answer": true, "approve": true, "deny": true, "cancel": true}}
		if len(parts) == 2 && identifier.MatchString(parts[0]) && allowed[parts[0]][parts[1]] {
			return nil
		}
		if len(parts) == 3 && identifier.MatchString(parts[1]) && allowed[parts[0]][parts[2]] {
			return nil
		}
	}
	return context.Canceled
}

func validQuery(path, raw string) bool {
	values, err := url.ParseQuery(raw)
	if err != nil || len(values) == 0 {
		return false
	}
	for key, value := range values {
		if len(value) != 1 {
			return false
		}
		n, err := strconv.ParseUint(value[0], 10, 64)
		if err != nil {
			return false
		}
		switch key {
		case "limit":
			if n < 1 || n > 100 {
				return false
			}
		case "offset":
			if n > 100000000 {
				return false
			}
		case "after":
			if n > 9223372036854775807 {
				return false
			}
		default:
			return false
		}
	}
	collection := path == "/api/v1/sessions" || path == "/api/v1/runs" || path == "/api/v1/pipelines" || path == "/api/v1/workers" || path == "/api/v1/worker-jobs" || path == "/api/v1/approvals" || path == "/api/v1/schedules" || path == "/api/v1/worker-requests"
	parts := strings.Split(strings.TrimPrefix(path, "/api/v1/sessions/"), "/")
	sessionTurns := strings.HasPrefix(path, "/api/v1/sessions/") && len(parts) == 2 && identifier.MatchString(parts[0]) && parts[1] == "turns"
	sessionEvents := strings.HasPrefix(path, "/api/v1/sessions/") && len(parts) == 2 && identifier.MatchString(parts[0]) && parts[1] == "events"
	if collection || sessionTurns {
		return values["limit"] != nil && values["offset"] != nil && values["after"] == nil
	}
	if sessionEvents {
		return values["after"] != nil && (values["limit"] == nil || values["limit"] != nil && values["offset"] == nil)
	}
	return false
}
