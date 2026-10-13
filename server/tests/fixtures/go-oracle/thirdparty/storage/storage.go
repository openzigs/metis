// Package storage is a DEPENDENCY: its import path ends like the project's
// own `storage/` directory.
package storage

// Save is the dependency's.
func Save() {}

// Conn is the dependency's type.
type Conn struct{}

// Ping is its method.
func (Conn) Ping() {}
