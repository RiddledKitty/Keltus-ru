// keltusanalytics is the standalone analytics service for keltus.ru.
// Privacy-respecting page-view counter with a periodic rollup and a small
// JSON read API consumed by the Directus admin extension.
//
// It listens on a local port (default 4328) and is fronted by nginx, which
// proxies /api/analytics/* to it. The static site posts page-views to
// /api/analytics/beacon; the Directus extension hits /api/analytics/admin/*.
//
// Configuration via env vars:
//
//	KELTUS_ANALYTICS_LISTEN     — bind address (default 127.0.0.1:4328)
//	KELTUS_ANALYTICS_DSN        — MariaDB DSN (required)
//	KELTUS_ANALYTICS_OWN_HOST   — canonical site host (e.g. keltus.ru) for self-referral collapsing
//	KELTUS_ANALYTICS_GEOIP      — path to GeoLite2-City.mmdb (optional; disables geo if empty)
//	KELTUS_ANALYTICS_ADMIN_TOKEN — bearer token required for /admin/* endpoints (optional in dev)
package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	_ "github.com/go-sql-driver/mysql"

	"keltus/analytics"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	listen := envOr("KELTUS_ANALYTICS_LISTEN", "127.0.0.1:4328")
	dsn := os.Getenv("KELTUS_ANALYTICS_DSN")
	if dsn == "" {
		slog.Error("KELTUS_ANALYTICS_DSN required")
		os.Exit(1)
	}
	ownHost := os.Getenv("KELTUS_ANALYTICS_OWN_HOST")
	geoPath := os.Getenv("KELTUS_ANALYTICS_GEOIP")
	adminToken := os.Getenv("KELTUS_ANALYTICS_ADMIN_TOKEN")

	db, err := sql.Open("mysql", dsn+"?parseTime=true&loc=UTC&charset=utf8mb4")
	if err != nil {
		slog.Error("db open", "err", err.Error())
		os.Exit(1)
	}
	defer db.Close()
	db.SetConnMaxLifetime(time.Hour)
	db.SetMaxIdleConns(5)
	db.SetMaxOpenConns(20)

	if err := db.Ping(); err != nil {
		slog.Error("db ping", "err", err.Error())
		os.Exit(1)
	}
	slog.Info("connected to MariaDB", "dsn_redacted", redactPassword(dsn))

	geo, err := analytics.OpenGeoLookup(geoPath)
	if err != nil {
		slog.Warn("geoip open failed — continuing without geo", "path", geoPath, "err", err.Error())
	} else if geo == nil {
		slog.Info("no GEOIP path set — geo lookups disabled")
	} else {
		slog.Info("geoip loaded", "path", geoPath)
		defer geo.Close()
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	salts := analytics.NewSaltCache(db)
	buf := analytics.NewBuffer(db)
	go buf.Run(ctx)
	affBuf := analytics.NewAffiliateBuffer(db)
	go affBuf.Run(ctx)
	affClickBuf := analytics.NewAffiliateClickBuffer(db)
	go affClickBuf.Run(ctx)
	go analytics.StartRollup(ctx, db, func(err error) {
		slog.Warn("rollup error", "err", err.Error())
	})

	h := &analytics.Handlers{
		DB:                   db,
		Salts:                salts,
		Geo:                  geo,
		Buffer:               buf,
		AffiliateBuffer:      affBuf,
		AffiliateClickBuffer: affClickBuf,
		OwnHost:              ownHost,
		AdminToken:           adminToken,
	}

	server := &http.Server{
		Addr:              listen,
		Handler:           h.Mux(),
		ReadTimeout:       15 * time.Second,
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		slog.Info("listening", "addr", listen, "admin_auth", adminToken != "")
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen", "err", err.Error())
			os.Exit(1)
		}
	}()

	// Graceful shutdown
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	<-sigs
	slog.Info("shutting down")
	cancel()
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	_ = server.Shutdown(shutCtx)
}

func envOr(key, dflt string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return dflt
}

// redactPassword turns "user:secret@tcp(host:port)/db" into "user:***@tcp(host:port)/db"
// so the connect log doesn't leak credentials into journald.
func redactPassword(dsn string) string {
	at := -1
	colon := -1
	for i := 0; i < len(dsn); i++ {
		if dsn[i] == '@' {
			at = i
			break
		}
		if dsn[i] == ':' && colon < 0 {
			colon = i
		}
	}
	if at <= 0 || colon <= 0 || colon >= at {
		return dsn
	}
	return dsn[:colon+1] + "***" + dsn[at:]
}
