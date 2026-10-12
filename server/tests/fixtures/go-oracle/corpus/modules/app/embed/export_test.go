package embed

// M on the EMBEDDED type E exists only in the test build: there it is at depth
// 1 of S and wins over F's (depth 2).
func (E) M() {}

// Reset is a test-only method declared directly on S.
func (S) Reset() {}

// TestOnly is a type only the test build has.
type TestOnly struct{ E }

// Probe is its own method.
func (TestOnly) Probe() {}

// Helper is a test-only function.
func Helper() *S { return &S{} }
