package web

import (
	"bufio"
	"errors"
	"net"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var (
	allowedHost = regexp.MustCompile(`^[a-zA-Z0-9.\-\[\]:]+$`)
	envKey      = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)
)

type Config struct {
	Bind, LASOURL, Token, Password string
	AllowedHosts                   map[string]struct{}
}

func ConfigFromEnv() (Config, error) {
	if err := loadEnvFile(".env"); err != nil {
		return Config{}, err
	}
	bind := strings.TrimSpace(env("LASO_WEB_BIND", "127.0.0.1"))
	port, err := strconv.Atoi(env("LASO_WEB_PORT", "8081"))
	if err != nil || port < 1 || port > 65535 {
		return Config{}, errors.New("LASO_WEB_PORT must be between 1 and 65535")
	}
	if net.ParseIP(bind) == nil && !strings.EqualFold(bind, "localhost") {
		return Config{}, errors.New("LASO_WEB_BIND must be an IP address or localhost")
	}
	upstream := strings.TrimRight(strings.TrimSpace(env("LASO_URL", "http://127.0.0.1:8080")), "/")
	u, err := url.Parse(upstream)
	if len(upstream) > 2048 || strings.ContainsAny(upstream, "\\\r\n\t ") || err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return Config{}, errors.New("LASO_URL must be an http(s) URL without credentials, query, or fragment")
	}
	password := os.Getenv("LASO_WEB_PASSWORD")
	loopback := strings.EqualFold(bind, "localhost") || (net.ParseIP(bind) != nil && net.ParseIP(bind).IsLoopback())
	if !loopback && (len(password) < 16 || len(password) > 1024) {
		return Config{}, errors.New("non-loopback bind requires LASO_WEB_PASSWORD with at least 16 characters")
	}
	if password != "" && (len(password) < 16 || len(password) > 1024) {
		return Config{}, errors.New("LASO_WEB_PASSWORD must contain between 16 and 1024 characters")
	}
	token := os.Getenv("LASO_TOKEN")
	if len(token) > 8192 || strings.ContainsAny(token, "\r\n") {
		return Config{}, errors.New("LASO_TOKEN exceeds the credential size limit")
	}
	hosts := map[string]struct{}{}
	for _, host := range strings.Split(os.Getenv("LASO_WEB_ALLOWED_HOSTS"), ",") {
		host = strings.ToLower(strings.TrimSpace(host))
		if host != "" {
			if len(host) > 255 || !allowedHost.MatchString(host) {
				return Config{}, errors.New("LASO_WEB_ALLOWED_HOSTS contains an invalid host entry")
			}
			hosts[host] = struct{}{}
		}
	}
	if !loopback && len(hosts) == 0 {
		return Config{}, errors.New("non-loopback bind requires LASO_WEB_ALLOWED_HOSTS")
	}
	if loopback && len(hosts) == 0 {
		for _, host := range []string{"localhost", "127.0.0.1", "[::1]"} {
			hosts[host+":"+strconv.Itoa(port)] = struct{}{}
		}
	}
	return Config{Bind: net.JoinHostPort(bind, strconv.Itoa(port)), LASOURL: upstream, Token: token, Password: password, AllowedHosts: hosts}, nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func loadEnvFile(path string) error {
	file, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return errors.New("cannot read LASO-Web .env file")
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	line := 0
	for scanner.Scan() {
		line++
		value := strings.TrimSpace(scanner.Text())
		if value == "" || strings.HasPrefix(value, "#") {
			continue
		}
		key, raw, ok := strings.Cut(value, "=")
		if !ok || !envKey.MatchString(strings.TrimSpace(key)) {
			return errors.New("invalid LASO-Web .env file")
		}
		key = strings.TrimSpace(key)
		raw = strings.TrimSpace(raw)
		if len(raw) >= 2 && ((raw[0] == '"' && raw[len(raw)-1] == '"') || (raw[0] == '\'' && raw[len(raw)-1] == '\'')) {
			raw = raw[1 : len(raw)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, raw)
		}
	}
	if scanner.Err() != nil || line > 1000 {
		return errors.New("invalid LASO-Web .env file")
	}
	return nil
}
