// Package lib1 and package lib2 declare the same names; two files of package
// twofiles import one each under the SAME local name.
package lib1

// V is lib1's.
type V struct{}

// Go is lib1.V's.
func (V) Go() {}

// New returns lib1's V.
func New() *V { return nil }
