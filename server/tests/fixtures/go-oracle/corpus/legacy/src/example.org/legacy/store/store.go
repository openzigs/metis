// Package store of a tree with NO go.mod: an import is matched to a directory
// by its spelling alone.
package store

// Save is example.org/legacy/store's.
func Save() {}

// Conn is a type of this package, reached through an import whose path only
// ends like the directory's one segment.
type Conn struct{}

// Open is Conn's.
func (Conn) Open() {}
