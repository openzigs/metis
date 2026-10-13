package embedx

import (
	"testing"

	"example.com/app/embed"
)

// probe is a type only this package's test build has.
type probe struct{ Outer }

// Deep on probe hides embed.F's in this package's tests.
func (probe) Deep() {}

func TestFromAnotherPackage(t *testing.T) {
	var s embed.S
	s.M()
	var o Outer
	o.M()
	var p probe
	p.Deep()
	p.M()
	Use(o, s)
	t.Log("ok")
}
