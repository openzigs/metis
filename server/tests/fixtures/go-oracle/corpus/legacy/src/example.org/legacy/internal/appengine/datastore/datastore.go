// Package datastore is the PROJECT's own package
// `example.org/legacy/internal/appengine/datastore`. Its directory is the only
// one of the tree that ends in `appengine/datastore` — two whole segments —
// and it is not the package with that import path: `internal` is not a GOPATH
// `src` (PR #1104, review cycle 7).
package datastore

// Get is the project's function. Nothing in the tree calls it.
func Get() {}
