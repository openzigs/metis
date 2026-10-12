// Package appengine is the PROJECT's own package
// `example.org/legacy/internal/appengine`. Its directory is the only one of
// the tree that ends in `appengine` — and it is not the package whose whole
// import path is `appengine`: `internal` is not a GOPATH `src`.
package appengine

// Main is the project's function. Nothing in the tree calls it.
func Main() {}
