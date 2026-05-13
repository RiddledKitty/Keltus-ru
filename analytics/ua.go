package analytics

import "strings"

// Tiny User-Agent classifier. Goal is "good enough for the
// dashboard pie charts," not anywhere near a full UA library.
// The four-bucket device class + roughly ten browser/OS strings
// covers >99% of real traffic; everything else collapses to
// "Other" rather than leaking a high-cardinality dimension into
// the aggregate tables.

// DeviceClass values must stay in sync with the ENUM in
// migrations/00062_analytics.sql.
type DeviceClass string

const (
	DeviceDesktop DeviceClass = "desktop"
	DeviceMobile  DeviceClass = "mobile"
	DeviceTablet  DeviceClass = "tablet"
	DeviceBot     DeviceClass = "bot"
	DeviceOther   DeviceClass = "other"
)

// botSubstrings are case-insensitive substrings that, when found
// in a UA, mean we should classify as DeviceBot. Kept in sync
// with internal/seo/detect.go's crawler list, plus a few obvious
// scraper-ish UAs the SEO list deliberately omits.
//
// Notably absent: "okhttp". It's the default Android HTTP client
// and tons of legitimate apps (including ours) use it. Catching
// "okhttp" as a bot would tag every Android-app visitor as a
// scraper. The server-side beacon handler takes the cop.chat-android
// UA below as a positive signal instead.
var botSubstrings = []string{
	"bot", "spider", "crawler", "slurp",
	"facebookexternalhit", "embedly", "preview",
	"curl/", "wget/", "python-requests", "go-http-client",
	"axios/", "http_get",
	"discordbot", "telegrambot", "slackbot", "twitterbot",
	"linkedinbot", "whatsapp", "applebot", "redditbot",
	"pinterest", "googleother", "google-inspection",
}

// ClassifyUA returns (device, browser, os, isBot) for a User-Agent
// string. All outputs are short, low-cardinality strings; the
// browser/os values come from a small allow-list (Chrome, Edge,
// Safari, Firefox, Opera, Samsung, Android-WebView, …) so two
// versions of Chrome don't fork into two breakdown rows.
func ClassifyUA(ua string) (DeviceClass, string, string, bool) {
	if ua == "" {
		return DeviceOther, "", "", false
	}
	low := strings.ToLower(ua)

	// First-party app strong-signal — beats the bot detector. The
	// Android client's AuthInterceptor sets a UA of the form
	// "cop.chat-android/<version> (Android <ver>; <make> <model>)".
	// iOS will follow the same convention when it lands.
	if strings.HasPrefix(low, "cop.chat-android") {
		return DeviceMobile, "cop.chat App", "Android", false
	}
	if strings.HasPrefix(low, "cop.chat-ios") {
		return DeviceMobile, "cop.chat App", "iOS", false
	}

	// Bot detection — "Mozilla/5.0 (compatible; Googlebot/2.1)" would
	// otherwise classify as desktop because it matches Mozilla but
	// not Mobi/Tablet. Run after the first-party app check above so
	// our own clients can never get caught by a generic substring.
	for _, s := range botSubstrings {
		if strings.Contains(low, s) {
			return DeviceBot, browserFamily(low), osFamily(low), true
		}
	}

	device := classifyDevice(low)
	return device, browserFamily(low), osFamily(low), false
}

func classifyDevice(low string) DeviceClass {
	switch {
	case strings.Contains(low, "ipad"),
		strings.Contains(low, "tablet"),
		strings.Contains(low, "kindle"),
		strings.Contains(low, "playbook"):
		return DeviceTablet
	case strings.Contains(low, "mobi"),
		strings.Contains(low, "iphone"),
		strings.Contains(low, "ipod"),
		strings.Contains(low, "android"),
		strings.Contains(low, "blackberry"),
		strings.Contains(low, "opera mini"),
		strings.Contains(low, "windows phone"):
		return DeviceMobile
	}
	return DeviceDesktop
}

func browserFamily(low string) string {
	// Order matters — Chrome's UA contains "Safari", Edge's contains
	// "Chrome", Brave/Opera contain "Chrome", etc. Match the most-
	// specific token first.
	switch {
	case strings.Contains(low, "edg/"), strings.Contains(low, "edge/"):
		return "Edge"
	case strings.Contains(low, "opr/"), strings.Contains(low, "opera/"):
		return "Opera"
	case strings.Contains(low, "brave/"):
		return "Brave"
	case strings.Contains(low, "samsungbrowser"):
		return "Samsung"
	case strings.Contains(low, "firefox/"), strings.Contains(low, "fxios/"):
		return "Firefox"
	case strings.Contains(low, "chrome/"), strings.Contains(low, "crios/"):
		return "Chrome"
	case strings.Contains(low, "safari/"):
		return "Safari"
	}
	return "Other"
}

func osFamily(low string) string {
	switch {
	case strings.Contains(low, "android"):
		return "Android"
	case strings.Contains(low, "iphone"), strings.Contains(low, "ipad"), strings.Contains(low, "ipod"):
		return "iOS"
	case strings.Contains(low, "mac os x"), strings.Contains(low, "macos"):
		return "macOS"
	case strings.Contains(low, "windows"):
		return "Windows"
	case strings.Contains(low, "cros"):
		return "ChromeOS"
	case strings.Contains(low, "linux"):
		return "Linux"
	case strings.Contains(low, "freebsd"), strings.Contains(low, "openbsd"), strings.Contains(low, "netbsd"):
		return "BSD"
	}
	return "Other"
}
