package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/whiskywater/laso-web/internal/web"
)

//go:embed static/*
var staticFiles embed.FS

func main() {
	config, err := web.ConfigFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	assets, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{Addr: config.Bind, Handler: web.NewServer(config, assets), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("LASO-Web listening on %s", config.Bind)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Print(err)
		os.Exit(1)
	}
}
