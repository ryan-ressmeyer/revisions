// Package web embeds the built web UI.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist is the output of the Vite build, with index.html at its root. On a
// checkout that has not run make build it holds only a placeholder.
func Dist() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
