package embed

import "io"

// Closer embeds an interface of the standard library: its method set is not
// known in full to a reader of the project alone.
type Closer interface {
	io.Closer
	Extra()
}

// WithOpen embeds it beside a struct.
type WithOpen struct {
	Closer
	Base
}

// Commented has comments where a field and a method are expected.
type Commented struct {
	// E is embedded.
	E
	// count is a plain field.
	count int
}

// Noted is an interface with a comment in its body.
type Noted interface {
	// Save is its only method.
	Save()
}

// WithNoted embeds it beside a struct.
type WithNoted struct {
	Noted
	Base
}

func open(w WithOpen, c Commented, n WithNoted) {
	w.Close()
	w.Extra()
	w.Foo()
	c.Mid()
	n.Save()
	n.Foo()
	_ = c.count
}
