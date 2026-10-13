// Package appstats is the PROJECT's own package `example.org/legacy/appstats`.
// Seen from the package root its directory is `appstats/`, at the tree root —
// and it is still not the package whose whole import path is `appstats`:
// nothing says that root is a GOPATH `src` (PR #1104, review cycle 7).
package appstats

// Main is the project's function. Nothing in the tree calls it.
func Main() {}
