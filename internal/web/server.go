package web

import (
	"crypto/subtle"
	"encoding/json"
	"io/fs"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
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
			if err != nil || !strings.EqualFold(u.Host, r.Host) || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
				s.writeJSON(w, http.StatusForbidden, map[string]string{"error": "Cross-origin state changes are not allowed"})
				return
			}
		}
		mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			s.writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "Content-Type must be application/json"})
			return
		}
		if r.ContentLength < 0 || len(r.Header.Values("Content-Length")) > 1 || len(r.Header.Values("Transfer-Encoding")) > 0 {
			s.writeJSON(w, http.StatusBadRequest, map[string]string{"error": "A single Content-Length header is required"})
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
