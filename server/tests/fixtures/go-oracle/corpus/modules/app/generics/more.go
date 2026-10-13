package generics

// U is a second type with Do: a type parameter named T, given U, reaches U's.
type U struct{}

// Do is U's.
func (U) Do() {}

// V is a package type named like Pair's second type parameter.
type V struct{}

// Do is V's.
func (V) Do() {}

// Scale is a generic function declared before the declarations below, so
// that its type parameter T is out of scope again when they are read.
func Scale[T any](v T) T { return v }

// Wide is a generic type whose parameter is named like the package type V.
type Wide[V any] struct{ Item V }

// global is declared AFTER a generic function: T is the package's type here.
var global T

// After is declared after a generic type: V is the package's type here.
type After struct{ F V }

func useMore(a After) {
	su := &Stack[U]{}
	su.Top().Do()
	pu := Pair[string, U]{}
	pu.Val.Do()
	pu.Value().Do()
	wu := Wide[U]{}
	wu.Item.Do()
	global.Do()
	a.F.Do()
	Apply[T](T{})
	_ = First[T]([]T{})
	_ = Scale[U](U{})
	_ = Pair[string, int](Pair[string, int]{})
	Each[T]([]T{})
}
