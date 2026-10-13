package main

import "appengine"

// gae calls the DEPENDENCY `appengine`: a tree with no go.mod whose only
// directory ending in that one segment is `internal/appengine` (PR #1104,
// review cycle 6).
func gae() {
	appengine.Main()
}
