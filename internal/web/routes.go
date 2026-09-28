package web

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var identifier = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,128}$`)

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
		if len(parts) == 2 && identifier.MatchString(parts[0]) && parts[1] == "context" && method == http.MethodGet {
			return nil
		}
	}
	if method == http.MethodPost && (base == "/api/v1/sessions" || base == "/api/v1/pipelines") {
		return nil
	}
	if method == http.MethodGet {
		parts := strings.Split(strings.TrimPrefix(base, "/api/v1/"), "/")
		collections := map[string]map[string]bool{"runs": {"": true, "messages": true, "events": true, "attempts": true, "context": true}, "pipelines": {"": true}, "workers": {"": true}, "approvals": {"": true}, "schedules": {"": true}, "worker-jobs": {"": true}, "worker-requests": {"": true}}
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
