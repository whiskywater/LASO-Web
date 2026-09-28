package web

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

type capabilityResponse struct {
	Advertised   bool     `json:"advertised"`
	Capabilities []string `json:"capabilities"`
}

// proxyCapabilities reads LASO's advertised version capabilities and preserves
// their exact names. An older LASO without an advertisement remains explicitly
// distinguishable so clients can use their existing API-probe fallback.
func (s *Server) proxyCapabilities(w http.ResponseWriter, r *http.Request) {
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, s.config.LASOURL+"/api/v1/version", nil)
	if err != nil {
		s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LASO version information is unavailable"})
		return
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "LASO-Web/Go")
	if s.config.Token != "" {
		request.Header.Set("Authorization", "Bearer "+s.config.Token)
	}
	response, err := s.client.Do(request)
	if err != nil {
		s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Cannot contact LASO", "detail": "LASO version information is unavailable"})
		return
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusMethodNotAllowed {
		s.writeJSON(w, http.StatusOK, capabilityResponse{Capabilities: []string{}})
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LASO version information is unavailable"})
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil || len(body) > maxResponse {
		s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LASO version response is unavailable or exceeds 4 MiB"})
		return
	}
	var version struct {
		Capabilities json.RawMessage `json:"capabilities"`
	}
	if json.Unmarshal(body, &version) != nil {
		s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LASO returned malformed version information"})
		return
	}
	if len(version.Capabilities) == 0 || string(version.Capabilities) == "null" {
		s.writeJSON(w, http.StatusOK, capabilityResponse{Capabilities: []string{}})
		return
	}
	var names []string
	if json.Unmarshal(version.Capabilities, &names) != nil || len(names) > 128 {
		s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LASO returned malformed capability information"})
		return
	}
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		if len(name) == 0 || len(name) > 128 || strings.ContainsAny(name, "\r\n\x00") {
			s.writeJSON(w, http.StatusBadGateway, map[string]string{"error": "LASO returned malformed capability information"})
			return
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
	}
	unique := make([]string, 0, len(seen))
	for _, name := range names {
		if _, exists := seen[name]; exists {
			unique = append(unique, name)
			delete(seen, name)
		}
	}
	s.writeJSON(w, http.StatusOK, capabilityResponse{Advertised: true, Capabilities: unique})
}
