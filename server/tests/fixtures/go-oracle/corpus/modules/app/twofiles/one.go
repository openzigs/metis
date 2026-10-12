// Package twofiles: an import name belongs to the FILE. `x` is lib1 here and
// lib2 in two.go, so a type written `x.V` means a different type in each.
package twofiles

import x "example.com/app/twofiles/lib1"

// One holds lib1's V.
type One struct{ F x.V }

// MakeOne returns lib1's V.
func MakeOne() *x.V { return nil }

// VarOne is lib1's V.
var VarOne x.V

// ListOne is a named slice of lib1's V.
type ListOne []x.V

func one(o One, t Two, l ListTwo) {
	o.F.Go()
	t.F.Go()
	x.New().Go()
	MakeTwo().Go()
	VarTwo.Go()
	l[0].Go()
}
