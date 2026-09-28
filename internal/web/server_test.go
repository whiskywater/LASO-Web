package web

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
)

type durableLASO struct {
	mu      sync.Mutex
	session map[string]any
	turns   []map[string]any
	events  []map[string]any
	next    int
	lastID  string
	auth    string
}

func (d *durableLASO) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.auth = r.Header.Get("Authorization")
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/sessions":
		if d.session == nil {
			_, _ = io.WriteString(w, "[]")
			return
		}
		_ = json.NewEncoder(w).Encode([]any{d.session})
	case r.Method == http.MethodPost && r.URL.Path == "/api/v1/sessions":
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		d.session = map[string]any{"id": "session-shared-1", "pipeline_id": body["pipeline_id"], "state": "open", "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z"}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(d.session)
	case r.URL.Path == "/api/v1/sessions/session-shared-1" && r.Method == http.MethodGet:
		if d.session == nil {
			http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(d.session)
	case r.URL.Path == "/api/v1/sessions/session-shared-1/turns" && r.Method == http.MethodGet:
		_ = json.NewEncoder(w).Encode(d.turns)
	case r.URL.Path == "/api/v1/sessions/session-shared-1/turns" && r.Method == http.MethodPost:
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		key := body["idempotency_key"].(string)
		for _, turn := range d.turns {
			if turn["idempotency_key"] == key {
				w.WriteHeader(http.StatusAccepted)
				_ = json.NewEncoder(w).Encode(turn)
				return
			}
		}
		d.next++
		turn := map[string]any{"id": fmt.Sprintf("turn-%d", d.next), "sequence": d.next, "idempotency_key": key, "input": body["input"], "state": "queued", "run_id": fmt.Sprintf("run-%d", d.next)}
		d.turns = append(d.turns, turn)
		d.events = append(d.events, map[string]any{"sequence": d.next, "type": "input.accepted", "turn_id": turn["id"]})
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(turn)
	case r.URL.Path == "/api/v1/sessions/session-shared-1/events":
		after, _ := url.QueryUnescape(r.URL.Query().Get("after"))
		var n int
		_, _ = fmt.Sscan(after, &n)
		out := []map[string]any{}
		for _, event := range d.events {
			if int(event["sequence"].(int)) > n {
				out = append(out, event)
			}
		}
		_ = json.NewEncoder(w).Encode(out)
	case r.URL.Path == "/api/v1/sessions/session-shared-1/events/stream":
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		var after int
		_, _ = fmt.Sscan(r.Header.Get("Last-Event-ID"), &after)
		d.lastID = r.Header.Get("Last-Event-ID")
		for _, event := range d.events {
			seq := int(event["sequence"].(int))
			if seq <= after {
				continue
			}
			payload, _ := json.Marshal(event)
			_, _ = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", seq, payload)
		}
	default:
		http.NotFound(w, r)
	}
}

func newTestFrontend(t *testing.T, upstream string) (*httptest.Server, Config) {
	t.Helper()
	config := Config{Bind: "127.0.0.1:8081", LASOURL: upstream, Token: "server-secret-token", AllowedHosts: map[string]struct{}{}}
	h := NewServer(config, testAssets(t))
	server := httptest.NewServer(h)
	config.AllowedHosts[strings.TrimPrefix(server.URL, "http://")] = struct{}{}
	h.config = config
	return server, config
}

func testAssets(t *testing.T) fs.FS {
	t.Helper()
	return os.DirFS("../../static")
}

func TestCapabilityAdapterUsesLASOVersionAdvertisement(t *testing.T) {
	var authorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		if r.URL.Path != "/api/v1/version" || r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"version":"0.1","capabilities":["sessions.durable","sessions.sse","sessions.context_generations","sessions.context_reduction"]}`)
	}))
	defer upstream.Close()
	front, _ := newTestFrontend(t, upstream.URL)
	defer front.Close()
	resp := call(t, front.Client(), http.MethodGet, front.URL+"/api/laso/capabilities", nil, strings.TrimPrefix(front.URL, "http://"), nil)
	defer resp.Body.Close()
	var got capabilityResponse
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&got) != nil {
		t.Fatalf("capability response status=%d", resp.StatusCode)
	}
	if !got.Advertised || len(got.Capabilities) != 4 || authorization != "Bearer server-secret-token" {
		t.Fatalf("advertisement=%+v authorization=%q", got, authorization)
	}
	if strings.Contains(strings.Join(got.Capabilities, ","), "server-secret-token") {
		t.Fatal("LASO bearer credential leaked in capability response")
	}
}

func TestCapabilityAdapterKeepsOlderLASOCapabilitiesUnknown(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"version":"older"}`)
	}))
	defer upstream.Close()
	front, _ := newTestFrontend(t, upstream.URL)
	defer front.Close()
	resp := call(t, front.Client(), http.MethodGet, front.URL+"/api/laso/capabilities", nil, strings.TrimPrefix(front.URL, "http://"), nil)
	defer resp.Body.Close()
	var got capabilityResponse
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&got) != nil || got.Advertised || len(got.Capabilities) != 0 {
		t.Fatalf("legacy LASO capability response status=%d value=%+v", resp.StatusCode, got)
	}
}

func TestCapabilityAdapterRejectsMalformedAdvertisementWithoutLeakingIt(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"capabilities":"password=upstream-secret"}`)
	}))
	defer upstream.Close()
	front, _ := newTestFrontend(t, upstream.URL)
	defer front.Close()
	resp := call(t, front.Client(), http.MethodGet, front.URL+"/api/laso/capabilities", nil, strings.TrimPrefix(front.URL, "http://"), nil)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusBadGateway || strings.Contains(string(body), "upstream-secret") {
		t.Fatalf("malformed capability response status=%d body=%s", resp.StatusCode, body)
	}
}

func call(t *testing.T, client *http.Client, method, endpoint string, body io.Reader, host string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, endpoint, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = host
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestTwoClientsShareDurableSessionAndReconnectByCursor(t *testing.T) {
	backend := &durableLASO{}
	laso := httptest.NewServer(backend)
	defer laso.Close()
	a, aConfig := newTestFrontend(t, laso.URL)
	defer a.Close()
	b, bConfig := newTestFrontend(t, laso.URL)
	defer b.Close()
	client := a.Client()
	created := call(t, client, http.MethodPost, a.URL+"/api/laso/sessions", strings.NewReader(`{"pipeline_id":"hello@1"}`), strings.TrimPrefix(a.URL, "http://"), map[string]string{"Content-Type": "application/json", "Origin": a.URL})
	if created.StatusCode != http.StatusCreated {
		t.Fatalf("create status = %d", created.StatusCode)
	}
	var session map[string]any
	_ = json.NewDecoder(created.Body).Decode(&session)
	created.Body.Close()
	first := call(t, client, http.MethodPost, a.URL+"/api/laso/sessions/session-shared-1/turns", strings.NewReader(`{"idempotency_key":"a-1","input":{"prompt":"from A"}}`), strings.TrimPrefix(a.URL, "http://"), map[string]string{"Content-Type": "application/json", "Origin": a.URL})
	if first.StatusCode != http.StatusAccepted {
		t.Fatalf("submit A status = %d", first.StatusCode)
	}
	first.Body.Close()
	get := call(t, b.Client(), http.MethodGet, b.URL+"/api/laso/sessions/session-shared-1/turns?limit=100&offset=0", nil, strings.TrimPrefix(b.URL, "http://"), nil)
	var turns []map[string]any
	_ = json.NewDecoder(get.Body).Decode(&turns)
	get.Body.Close()
	if get.StatusCode != http.StatusOK || len(turns) != 1 || turns[0]["sequence"].(float64) != 1 {
		t.Fatalf("B did not observe A's turn: %#v status %d", turns, get.StatusCode)
	}
	retry := call(t, client, http.MethodPost, a.URL+"/api/laso/sessions/session-shared-1/turns", strings.NewReader(`{"idempotency_key":"a-1","input":{"prompt":"from A"}}`), strings.TrimPrefix(a.URL, "http://"), map[string]string{"Content-Type": "application/json", "Origin": a.URL})
	if retry.StatusCode != http.StatusAccepted {
		t.Fatalf("idempotent retry status = %d", retry.StatusCode)
	}
	retry.Body.Close()
	sse := call(t, b.Client(), http.MethodGet, b.URL+"/api/laso/sessions/session-shared-1/events/stream", nil, strings.TrimPrefix(b.URL, "http://"), map[string]string{"Accept": "text/event-stream"})
	streamBytes, _ := io.ReadAll(sse.Body)
	sse.Body.Close()
	if sse.StatusCode != http.StatusOK || !strings.Contains(string(streamBytes), "id: 1\n") {
		t.Fatalf("initial SSE replay missing: %s", streamBytes)
	}
	second := call(t, b.Client(), http.MethodPost, b.URL+"/api/laso/sessions/session-shared-1/turns", strings.NewReader(`{"idempotency_key":"b-1","input":{"prompt":"from B"}}`), strings.TrimPrefix(b.URL, "http://"), map[string]string{"Content-Type": "application/json", "Origin": b.URL})
	if second.StatusCode != http.StatusAccepted {
		t.Fatalf("submit B status = %d", second.StatusCode)
	}
	second.Body.Close()
	replay := call(t, a.Client(), http.MethodGet, a.URL+"/api/laso/sessions/session-shared-1/events/stream", nil, strings.TrimPrefix(a.URL, "http://"), map[string]string{"Accept": "text/event-stream", "Last-Event-ID": "1"})
	replayBytes, _ := io.ReadAll(replay.Body)
	replay.Body.Close()
	if !strings.Contains(string(replayBytes), "id: 2\n") || strings.Contains(string(replayBytes), "id: 1\n") {
		t.Fatalf("resume cursor replay incorrect: %s", replayBytes)
	}
	backend.mu.Lock()
	if backend.lastID != "1" {
		t.Errorf("Last-Event-ID was not forwarded: %q", backend.lastID)
	}
	backend.mu.Unlock()
	final := call(t, a.Client(), http.MethodGet, a.URL+"/api/laso/sessions/session-shared-1/turns?limit=100&offset=0", nil, strings.TrimPrefix(a.URL, "http://"), nil)
	_ = json.NewDecoder(final.Body).Decode(&turns)
	final.Body.Close()
	if len(turns) != 2 || turns[0]["sequence"].(float64) != 1 || turns[1]["sequence"].(float64) != 2 {
		t.Fatalf("ordered shared history = %#v", turns)
	}
	if aConfig.Token == "" || bConfig.Token == "" {
		t.Fatal("test setup lost server-side token")
	}
	backend.mu.Lock()
	if backend.auth != "Bearer server-secret-token" {
		t.Errorf("upstream bearer was not sent server-side: %q", backend.auth)
	}
	backend.mu.Unlock()
}

func TestAdapterRejectsUnsafeRoutesOriginAndBadSessionID(t *testing.T) {
	backend := httptest.NewServer(http.NotFoundHandler())
	defer backend.Close()
	front, config := newTestFrontend(t, backend.URL)
	defer front.Close()
	client := front.Client()
	host := strings.TrimPrefix(front.URL, "http://")
	for _, path := range []string{"/api/laso/sessions/a%2F..%2Fb", "/api/laso/anything"} {
		resp := call(t, client, http.MethodGet, front.URL+path, nil, host, nil)
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("%s status=%d", path, resp.StatusCode)
		}
		resp.Body.Close()
	}
	resp := call(t, client, http.MethodPost, front.URL+"/api/laso/sessions", strings.NewReader(`{"pipeline_id":"hello@1"}`), host, map[string]string{"Content-Type": "application/json", "Origin": "https://evil.example"})
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("cross-origin status=%d", resp.StatusCode)
	}
	resp.Body.Close()
	if _, ok := config.AllowedHosts[host]; !ok {
		t.Fatal("allowed host test setup failed")
	}
}

func TestSessionRouteCompatibilityAndCapabilityNotFromRequest(t *testing.T) {
	oldLASO := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"Endpoint not found"}`)
	}))
	defer oldLASO.Close()
	front, _ := newTestFrontend(t, oldLASO.URL)
	defer front.Close()
	resp := call(t, front.Client(), http.MethodGet, front.URL+"/api/laso/sessions?limit=20&offset=0", nil, strings.TrimPrefix(front.URL, "http://"), nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unsupported sessions response=%d", resp.StatusCode)
	}
	resp.Body.Close()
	if validateRoute(http.MethodGet, "/api/v1/sessions?limit=1&offset=0&capabilities=all", false) == nil {
		t.Fatal("browser-supplied capability claims must not be forwarded")
	}
}

func TestRouteValidation(t *testing.T) {
	cases := []struct {
		method, path string
		stream, ok   bool
	}{
		{http.MethodGet, "/api/v1/sessions?limit=50&offset=0", false, true},
		{http.MethodGet, "/api/v1/sessions/abc/turns?limit=100&offset=0", false, true},
		{http.MethodGet, "/api/v1/sessions/abc/context", false, true},
		{http.MethodGet, "/api/v1/runs/run-1/context", false, true},
		{http.MethodGet, "/api/v1/sessions/abc/events?after=10&limit=50", false, true},
		{http.MethodGet, "/api/v1/sessions/abc/events/stream", true, true},
		{http.MethodPost, "/api/v1/sessions/abc/turns", false, true},
		{http.MethodGet, "/api/v1/sessions/abc/events/stream", false, false},
		{http.MethodGet, "/api/v1/sessions/abc/events?after=-1", false, false},
		{http.MethodGet, "/api/v1/sessions/abc/events?after=1&evil=yes", false, false},
	}
	for _, tc := range cases {
		got := validateRoute(tc.method, tc.path, tc.stream) == nil
		if got != tc.ok {
			t.Errorf("validateRoute(%s,%s)=%t", tc.method, tc.path, got)
		}
	}
}

func TestPythonWorkspaceRouteParity(t *testing.T) {
	valid := []struct {
		method, path string
		stream       bool
	}{
		{http.MethodGet, "/api/v1/health", false},
		{http.MethodGet, "/api/v1/version", false},
		{http.MethodGet, "/api/v1/pipelines?limit=100&offset=0", false},
		{http.MethodPost, "/api/v1/pipelines", false},
		{http.MethodGet, "/api/v1/pipelines/hello@1", false},
		{http.MethodPost, "/api/v1/pipelines/hello@1/runs", false},
		{http.MethodGet, "/api/v1/runs?limit=100&offset=0", false},
		{http.MethodGet, "/api/v1/runs/run-1", false},
		{http.MethodGet, "/api/v1/runs/run-1/messages", false},
		{http.MethodGet, "/api/v1/runs/run-1/events", false},
		{http.MethodGet, "/api/v1/runs/run-1/attempts", false},
		{http.MethodPost, "/api/v1/runs/run-1/cancel", false},
		{http.MethodPost, "/api/v1/runs/run-1/resume", false},
		{http.MethodGet, "/api/v1/workers?limit=100&offset=0", false},
		{http.MethodGet, "/api/v1/worker-jobs?limit=100&offset=0", false},
		{http.MethodGet, "/api/v1/worker-jobs/job-1", false},
		{http.MethodPost, "/api/v1/worker-jobs/job-1/cancel", false},
		{http.MethodGet, "/api/v1/approvals?limit=100&offset=0", false},
		{http.MethodGet, "/api/v1/approvals/approval-1", false},
		{http.MethodPost, "/api/v1/approvals/approval-1/approve", false},
		{http.MethodPost, "/api/v1/approvals/approval-1/reject", false},
		{http.MethodGet, "/api/v1/worker-requests?limit=100&offset=0", false},
		{http.MethodGet, "/api/v1/worker-requests/request-1", false},
		{http.MethodPost, "/api/v1/worker-requests/request-1/respond", false},
		{http.MethodPost, "/api/v1/worker-requests/request-1/answer", false},
		{http.MethodPost, "/api/v1/worker-requests/request-1/approve", false},
		{http.MethodPost, "/api/v1/worker-requests/request-1/deny", false},
		{http.MethodPost, "/api/v1/worker-requests/request-1/cancel", false},
		{http.MethodGet, "/api/v1/schedules?limit=100&offset=0", false},
		{http.MethodGet, "/api/v1/schedules/schedule-1", false},
		{http.MethodPost, "/api/v1/schedules/schedule-1/enable", false},
		{http.MethodPost, "/api/v1/schedules/schedule-1/disable", false},
		{http.MethodGet, "/api/v1/sessions?limit=100&offset=0", false},
		{http.MethodGet, "/api/v1/sessions/session-1/events/stream", true},
	}
	for _, tc := range valid {
		if err := validateRoute(tc.method, tc.path, tc.stream); err != nil {
			t.Errorf("workspace operation rejected: %s %s", tc.method, tc.path)
		}
	}
	invalid := []struct{ method, path string }{
		{http.MethodGet, "/api/v1/artifacts?limit=100&offset=0"},
		{http.MethodPost, "/api/v1/workers/worker-1/start"},
		{http.MethodGet, "/api/v1/runs/run-1/events?next=http://evil"},
		{http.MethodPost, "/api/v1/approvals/approval-1/approve?limit=1&offset=0"},
		{http.MethodGet, "/api/v1/runs/a%2F..%2Fb"},
	}
	for _, tc := range invalid {
		if err := validateRoute(tc.method, tc.path, false); err == nil {
			t.Errorf("unsafe/unavailable operation accepted: %s %s", tc.method, tc.path)
		}
	}
}

func TestWorkspaceAssetsAndOperatorRoutesAreServedByGo(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `[]`)
	}))
	defer backend.Close()
	front, _ := newTestFrontend(t, backend.URL)
	defer front.Close()
	host := strings.TrimPrefix(front.URL, "http://")
	for _, path := range []string{"/", "/app.js", "/model.js", "/capabilities.js", "/style.css", "/sessions.js"} {
		resp := call(t, front.Client(), http.MethodGet, front.URL+path, nil, host, nil)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("asset %s status=%d", path, resp.StatusCode)
		}
		resp.Body.Close()
	}
	for _, path := range []string{"/api/laso/health", "/api/laso/version", "/api/laso/pipelines?limit=100&offset=0", "/api/laso/runs?limit=100&offset=0", "/api/laso/workers?limit=100&offset=0", "/api/laso/worker-jobs?limit=100&offset=0", "/api/laso/approvals?limit=100&offset=0", "/api/laso/worker-requests?limit=100&offset=0", "/api/laso/schedules?limit=100&offset=0"} {
		resp := call(t, front.Client(), http.MethodGet, front.URL+path, nil, host, nil)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("operator API route %s status=%d", path, resp.StatusCode)
		}
		resp.Body.Close()
	}
}

func TestSessionDeepLinkServesReloadableApplication(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/sessions/session-direct" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"id":"session-direct","state":"open","pipeline_id":"hello@1"}`)
			return
		}
		http.NotFound(w, r)
	}))
	defer backend.Close()
	front, _ := newTestFrontend(t, backend.URL)
	defer front.Close()
	host := strings.TrimPrefix(front.URL, "http://")
	page := call(t, front.Client(), http.MethodGet, front.URL+"/sessions/session-direct", nil, host, nil)
	pageBody, _ := io.ReadAll(page.Body)
	page.Body.Close()
	if page.StatusCode != http.StatusOK || !strings.Contains(string(pageBody), "session.js") {
		t.Fatalf("deep link did not serve session app: %d", page.StatusCode)
	}
	asset := call(t, front.Client(), http.MethodGet, front.URL+"/session-model.js", nil, host, nil)
	assetBody, _ := io.ReadAll(asset.Body)
	asset.Body.Close()
	if asset.StatusCode != http.StatusOK || !strings.Contains(string(assetBody), "class Cursor") {
		t.Fatalf("session model asset missing: %d", asset.StatusCode)
	}
}

func TestMalformedLASOConversationResponseFailsSafely(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "not-json") }))
	defer backend.Close()
	front, _ := newTestFrontend(t, backend.URL)
	defer front.Close()
	resp := call(t, front.Client(), http.MethodGet, front.URL+"/api/laso/sessions?limit=1&offset=0", nil, strings.TrimPrefix(front.URL, "http://"), nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || strings.Contains(string(body), "not-json") {
		t.Fatalf("malformed upstream response leaked through: %d %q", resp.StatusCode, body)
	}
}

func TestRunWorkspaceStillWorksWhenSessionsAreUnsupported(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/runs":
			_, _ = io.WriteString(w, `[{"id":"run-legacy","state":"Completed"}]`)
		case "/api/v1/sessions":
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, `{"error":"Endpoint not found"}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer backend.Close()
	front, _ := newTestFrontend(t, backend.URL)
	defer front.Close()
	host := strings.TrimPrefix(front.URL, "http://")
	legacy := call(t, front.Client(), http.MethodGet, front.URL+"/api/laso/runs?limit=100&offset=0", nil, host, nil)
	if legacy.StatusCode != http.StatusOK {
		t.Fatalf("run API status %d", legacy.StatusCode)
	}
	var runs []map[string]any
	_ = json.NewDecoder(legacy.Body).Decode(&runs)
	legacy.Body.Close()
	if len(runs) != 1 || runs[0]["id"] != "run-legacy" {
		t.Fatalf("run API response %#v", runs)
	}
	unsupported := call(t, front.Client(), http.MethodGet, front.URL+"/api/laso/sessions?limit=1&offset=0", nil, host, nil)
	if unsupported.StatusCode != http.StatusNotFound {
		t.Fatalf("legacy LASO session status %d", unsupported.StatusCode)
	}
	unsupported.Body.Close()
}

func TestRemoteBindRequiresStrongPasswordAndAllowedHosts(t *testing.T) {
	t.Setenv("LASO_URL", "http://127.0.0.1:8080")
	t.Setenv("LASO_WEB_BIND", "0.0.0.0")
	t.Setenv("LASO_WEB_PORT", "8081")
	t.Setenv("LASO_WEB_PASSWORD", "")
	t.Setenv("LASO_WEB_ALLOWED_HOSTS", "")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("remote bind accepted without password")
	}
	t.Setenv("LASO_WEB_PASSWORD", "test-password-that-is-long-enough")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("remote bind accepted without host allowlist")
	}
	t.Setenv("LASO_WEB_ALLOWED_HOSTS", "laso.example.test")
	config, err := ConfigFromEnv()
	if err != nil {
		t.Fatalf("valid remote config rejected: %v", err)
	}
	if _, ok := config.AllowedHosts["laso.example.test"]; !ok {
		t.Fatal("configured Host not allowed")
	}
}

func TestLASOBearerStaysServerSide(t *testing.T) {
	var received string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"ok"}`)
	}))
	defer backend.Close()
	front, _ := newTestFrontend(t, backend.URL)
	defer front.Close()
	resp := call(t, front.Client(), http.MethodGet, front.URL+"/api/laso/health", nil, strings.TrimPrefix(front.URL, "http://"), nil)
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if received != "Bearer server-secret-token" {
		t.Fatalf("LASO did not receive configured server credential: %q", received)
	}
	if strings.Contains(string(data), "server-secret-token") || resp.Header.Get("Authorization") != "" {
		t.Fatal("server credential leaked to browser response")
	}
}

func TestGoWorkspaceAuthOriginAndBodyLimits(t *testing.T) {
	var upstreamCalls int
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"ok"}`)
	}))
	defer backend.Close()
	config := Config{Bind: "127.0.0.1:8081", LASOURL: backend.URL, Password: "sixteen-character-password", AllowedHosts: map[string]struct{}{}}
	h := NewServer(config, testAssets(t))
	front := httptest.NewServer(h)
	defer front.Close()
	config.AllowedHosts[strings.TrimPrefix(front.URL, "http://")] = struct{}{}
	h.config = config
	host := strings.TrimPrefix(front.URL, "http://")
	client := front.Client()

	unauthorized := call(t, client, http.MethodGet, front.URL+"/api/laso/health", nil, host, nil)
	if unauthorized.StatusCode != http.StatusUnauthorized || unauthorized.Header.Get("WWW-Authenticate") == "" {
		t.Fatalf("unauthorized request status=%d", unauthorized.StatusCode)
	}
	unauthorized.Body.Close()

	large := strings.Repeat("x", maxBody+1)
	resp := call(t, client, http.MethodPost, front.URL+"/api/laso/pipelines", strings.NewReader(large), host,
		map[string]string{"Authorization": "Basic b3BlcmF0b3I6c2l4dGVlbi1jaGFyYWN0ZXItcGFzc3dvcmQ=", "Content-Type": "application/json", "Origin": front.URL})
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized body status=%d", resp.StatusCode)
	}
	resp.Body.Close()

	badOrigin := call(t, client, http.MethodPost, front.URL+"/api/laso/pipelines", strings.NewReader(`{}`), host,
		map[string]string{"Authorization": "Basic b3BlcmF0b3I6c2l4dGVlbi1jaGFyYWN0ZXItcGFzc3dvcmQ=", "Content-Type": "application/json", "Origin": front.URL + "/path"})
	if badOrigin.StatusCode != http.StatusForbidden {
		t.Fatalf("non-origin URL status=%d", badOrigin.StatusCode)
	}
	badOrigin.Body.Close()
	if upstreamCalls != 0 {
		t.Fatalf("invalid requests reached LASO %d times", upstreamCalls)
	}
}

func TestUpstreamRedirectIsNeverFollowed(t *testing.T) {
	var hits int
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.URL.Path == "/api/v1/health" {
			http.Redirect(w, r, "http://127.0.0.1:1/credential-leak", http.StatusFound)
			return
		}
		http.Error(w, "unexpected redirect target", http.StatusInternalServerError)
	}))
	defer backend.Close()
	front, _ := newTestFrontend(t, backend.URL)
	defer front.Close()
	resp := call(t, front.Client(), http.MethodGet, front.URL+"/api/laso/health", nil, strings.TrimPrefix(front.URL, "http://"), nil)
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || hits != 1 || strings.Contains(string(data), "credential-leak") {
		t.Fatalf("redirect handling status=%d hits=%d body=%s", resp.StatusCode, hits, data)
	}
}
