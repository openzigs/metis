// Package embedx uses package embed from ANOTHER directory: embed's test-only
// declarations are not part of what this package, or its tests, are built with.
package embedx

import "example.com/app/embed"

// Outer embeds embed.S, so M is promoted from three levels down.
type Outer struct{ embed.S }

// Use calls the promoted method from a non-test file.
func Use(o Outer, s embed.S) {
	o.M()
	s.M()
	o.Mid()
}
