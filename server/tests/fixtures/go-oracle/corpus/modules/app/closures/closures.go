// Package closures: a func literal is its own scope, with its own parameters
// and named results, and it captures what the enclosing function declared.
package closures

// A and B both declare Run, so a variable resolved to the wrong one binds a
// wrong method.
type A struct{}

// Run is A's.
func (A) Run() {}

// B is the other type.
type B struct{}

// Run is B's.
func (B) Run() {}

// NewA returns an A.
func NewA() *A { return nil }

// NewB returns a B.
func NewB() *B { return nil }

// h is a package variable: a closure's named result of the same name hides it.
var h A

// s is a package variable hidden by locals named s.
var s B

func iife() {
	a, b := func() (*A, *B) { return nil, nil }()
	a.Run()
	b.Run()
}

func iifeThree() {
	x, y, z := func() (*B, *A, *B) { return nil, nil, nil }()
	x.Run()
	y.Run()
	z.Run()
}

func closureResult() {
	_ = func() (h interface{ Run() }) {
		h.Run()
		return nil
	}
	h.Run()
}

func closureNamedResults() {
	_ = func() (first *B, second *A) {
		first.Run()
		second.Run()
		return nil, nil
	}
}

func closureScope() {
	s := NewA()
	go func() {
		s := NewB()
		s.Run()
	}()
	s.Run()
}

func closureParam() {
	s := NewA()
	func(s *B) {
		s.Run()
	}(nil)
	s.Run()
}

func closureParamUnmodelled() {
	func(s interface{ Run() }) {
		s.Run()
	}(nil)
	s.Run()
}

func captured() {
	v := NewA()
	f := func() {
		v.Run()
	}
	f()
}

func capturedThenShadowed() {
	v := NewA()
	defer func() {
		v.Run()
		v := NewB()
		v.Run()
	}()
	v.Run()
}

func nested() {
	v := NewA()
	func() {
		func() {
			v := NewB()
			v.Run()
		}()
		v.Run()
	}()
}

func namedResults() (r *A, other *B) {
	r.Run()
	other.Run()
	return nil, nil
}

func namedResultUnmodelled() (h interface{ Run() }) {
	h.Run()
	return nil
}

func paramUnmodelled(h interface{ Run() }, s func() *A) {
	h.Run()
	s().Run()
}

func typeParams[T interface{ Run() }](t T, mk func() T) {
	t.Run()
	mk().Run()
}

func funcTypedLocal() {
	mk := func() *B { return nil }
	mk().Run()
	var mk2 func() *A
	mk2().Run()
}

func closureAssignsOuter() {
	v := NewA()
	func() {
		v = NewA()
	}()
	v.Run()
}

var pkgLevel = func() *B {
	v := NewB()
	v.Run()
	return v
}()

func init() {
	pkgLevel.Run()
	typeParams[A](A{}, func() A { return A{} })
	iife()
}
