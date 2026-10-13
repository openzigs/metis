// Package model declares the types other packages reach through an alias, a
// defined type, an underlying type, an embedded field, a package variable and a
// func-typed value. Package service declares types of the SAME NAMES, so a type
// name resolved in the wrong file's scope binds a wrong method.
package model

// Thing is the type every probe selects a method from.
type Thing struct{ ID int }

// Run has a value receiver.
func (Thing) Run() {}

// Stop has a pointer receiver.
func (t *Thing) Stop() {}

// Maker is a func type whose result is written in THIS file's scope.
type Maker func() *Thing

// List, Index and Feed are named composite types over Thing.
type List []*Thing

// Index is a named map.
type Index map[string]*Thing

// Feed is a named channel.
type Feed chan *Thing

// Alias is an alias of Thing.
type Alias = Thing

// Inner holds a Thing.
type Inner struct{ F *Thing }

// Wrapped is a defined type over a struct: it keeps Inner's fields.
type Wrapped Inner

// Lists is a defined type over a named slice: an underlying type two links away.
type Lists List

// Base is embedded by Holder.
type Base struct{}

// Hello is promoted through Holder.
func (Base) Hello() {}

// Holder embeds Base.
type Holder struct{ Base }

// Runner is a project interface.
type Runner interface{ Run() }

// Default is a package variable whose type is written.
var Default *Thing

// Factory is a package variable of a func type.
var Factory Maker

// Shared is a package variable whose type comes from its initialiser.
var Shared = &Thing{}

// Pool and Spare are declared together.
var Pool, Spare = NewPool(), &Thing{}

// First and Second come from one call with two results.
var First, Second = Pair()

// New returns an interface value.
func New() Runner { return Thing{} }

// NewThing returns a concrete value.
func NewThing() *Thing { return &Thing{} }

// NewPool returns a named slice.
func NewPool() List { return nil }

// Pair returns two values of different types.
func Pair() (*Thing, *Base) { return &Thing{}, &Base{} }

// Anon returns a value of an interface type written in place.
func Anon() interface{ Run() } { return Thing{} }
