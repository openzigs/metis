//go:build !windows

package platform

// shared is declared once for every platform but Windows, and once for Windows.
func shared() string { return "unix" }

// Conn is a type with a twin behind the other constraint.
type Conn struct{}

// Open is declared on both twins of Conn.
func (Conn) Open() {}
