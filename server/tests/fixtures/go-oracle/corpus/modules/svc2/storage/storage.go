// Package storage of the SECOND of two services that are each `module app`.
package storage

// Open is svc2's.
func Open() *DB { return nil }

// DB is svc2's.
type DB struct{}

// Ping is svc2's.
func (*DB) Ping() {}
