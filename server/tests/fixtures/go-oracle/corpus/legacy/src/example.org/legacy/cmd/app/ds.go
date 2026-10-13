package main

import "appengine/datastore"

// ds calls the DEPENDENCY `appengine/datastore`: a tree with no go.mod whose
// only directory ending in those two segments is
// `internal/appengine/datastore` (PR #1104, review cycle 7).
func ds() {
	datastore.Get()
}
