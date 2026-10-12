// Package storage of the FIRST of two services that are each `module app`.
package storage

// Open is svc1's.
func Open() *DB { return nil }

// DB is svc1's.
type DB struct{}

// Ping is svc1's.
func (*DB) Ping() {}
