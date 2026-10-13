// Package generics: type parameters. A value of a type-parameter type has no
// declared type to bind through; a generic type's own methods do.
package generics

import "example.com/app/model"

// T is a package type named like the type parameters below.
type T struct{}

// Do is T's method: a type parameter named T must never reach it.
func (T) Do() {}

// Stack is a generic type.
type Stack[T any] struct{ items []T }

// Push is declared on the generic type.
func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }

// Top returns a value of the type argument.
func (s *Stack[T]) Top() T { return s.items[0] }

// Pair has two type parameters.
type Pair[K comparable, V any] struct {
	Key K
	Val V
}

// Value returns the second type argument.
func (p Pair[K, V]) Value() V { return p.Val }

// First is a generic function.
func First[T any](xs []T) T { return xs[0] }

// Make is called with an explicit type argument.
func Make[T any]() T {
	var zero T
	return zero
}

// Apply calls a method through a constraint.
func Apply[T interface{ Do() }](v T) {
	v.Do()
}

// Doer is a constraint with a method.
type Doer interface{ Do() }

// Each ranges over a slice of a type parameter.
func Each[T Doer](xs []T) {
	for _, x := range xs {
		x.Do()
	}
	var t T
	t.Do()
}

func use(things []*model.Thing) {
	st := &Stack[*model.Thing]{}
	st.Push(nil)
	st.Top().Run()
	First(things).Stop()
	Make[*model.Thing]().Run()
	Apply(T{})
	Each([]T{})
	p := Pair[string, *model.Thing]{}
	p.Value().Run()
	p.Val.Stop()
	var t T
	t.Do()
}
