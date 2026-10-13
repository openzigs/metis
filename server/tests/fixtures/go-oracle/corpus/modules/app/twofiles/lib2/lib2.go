package lib2

// V is lib2's.
type V struct{}

// Go is lib2.V's.
func (V) Go() {}

// New returns lib2's V.
func New() *V { return nil }
