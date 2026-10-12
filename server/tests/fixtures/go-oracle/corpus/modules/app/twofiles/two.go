package twofiles

import x "example.com/app/twofiles/lib2"

// Two holds lib2's V.
type Two struct{ F x.V }

// MakeTwo returns lib2's V.
func MakeTwo() *x.V { return nil }

// VarTwo is lib2's V.
var VarTwo x.V

// ListTwo is a named slice of lib2's V.
type ListTwo []x.V

func two(o One, t Two, l ListOne) {
	o.F.Go()
	t.F.Go()
	x.New().Go()
	MakeOne().Go()
	VarOne.Go()
	l[0].Go()
}
