package analytics

import (
	"net/url"
	"strings"
)

// NormalizePath strips the query string, fragment, and trailing
// slash; clamps to 255 chars to fit the column. The exception is
// /search where we keep `?q=` because the admin will reasonably
// want "what are people searching for?". Anything else loses its
// query — keeping IDs in /forums/{id} matters, but tracking-junk
// like ?utm_source= and ?ref= would just bloat the cardinality.
func NormalizePath(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return clamp(rawURL, 255)
	}
	p := u.Path
	if p == "" {
		p = "/"
	}
	// Strip trailing slash except on root.
	if len(p) > 1 && strings.HasSuffix(p, "/") {
		p = strings.TrimRight(p, "/")
	}
	if p == "/search" {
		if q := u.Query().Get("q"); q != "" {
			p = p + "?q=" + q
		}
	}
	return clamp(p, 255)
}

// ReferrerHost returns the bare host of the Referer header (no
// scheme, no path, no port). Empty when missing or unparseable.
// "Direct" referrers (clicks from outside the address bar that
// elide the header) become "" — the dashboard renders that as
// "(direct)".
func ReferrerHost(refHeader, ownHost string) string {
	if refHeader == "" {
		return ""
	}
	u, err := url.Parse(refHeader)
	if err != nil {
		return ""
	}
	host := u.Hostname()
	if host == "" {
		return ""
	}
	host = strings.ToLower(host)
	// In-app navigation isn't a referrer — collapse to "".
	if ownHost != "" && strings.EqualFold(host, ownHost) {
		return ""
	}
	return clamp(host, 128)
}

// IsTrackable returns false for paths the analytics middleware
// should never count: API/SSE traffic, hashed asset bundles,
// the OG image generator, the admin shell itself (so an admin
// reloading the dashboard doesn't show up as "active users"),
// and miscellaneous browser pings.
func IsTrackable(path string) bool {
	if path == "" {
		return false
	}
	switch {
	case strings.HasPrefix(path, "/api/"),
		strings.HasPrefix(path, "/sse/"),
		strings.HasPrefix(path, "/og/"),
		strings.HasPrefix(path, "/admin"),
		strings.HasPrefix(path, "/assets/"),
		strings.HasPrefix(path, "/static/"),
		path == "/favicon.ico",
		path == "/robots.txt",
		path == "/sitemap.xml",
		strings.HasPrefix(path, "/sitemap-"),
		strings.HasPrefix(path, "/.well-known/"),
		strings.HasSuffix(path, ".js"),
		strings.HasSuffix(path, ".css"),
		strings.HasSuffix(path, ".map"),
		strings.HasSuffix(path, ".png"),
		strings.HasSuffix(path, ".jpg"),
		strings.HasSuffix(path, ".jpeg"),
		strings.HasSuffix(path, ".gif"),
		strings.HasSuffix(path, ".webp"),
		strings.HasSuffix(path, ".svg"),
		strings.HasSuffix(path, ".ico"),
		strings.HasSuffix(path, ".woff"),
		strings.HasSuffix(path, ".woff2"),
		strings.HasSuffix(path, ".ttf"):
		return false
	}
	return true
}

func clamp(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
