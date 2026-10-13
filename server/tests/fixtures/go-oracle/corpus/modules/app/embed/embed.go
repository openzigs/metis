// Package embed: promotion through embedded fields, by Go's shallowest-depth
// rule — at several depths, through pointers, a struct beside an interface, and
// two interfaces side by side.
package embed

import "example.com/app/model"

// F is the deepest type of the S chain.
type F struct{}

// M is declared on F here, and on E in export_test.go: a test caller reaches
// E's (depth 1), any other caller F's (depth 2).
func (F) M() {}

// Deep is only on F.
func (F) Deep() {}

// E embeds F.
type E struct{ F }

// Mid is only on E.
func (E) Mid() {}

// S embeds E.
type S struct{ E }

// Own is S's own method.
func (S) Own() {}

// Store and Logger are two project interfaces with different methods.
type Store interface{ Save() }

// Logger is the second interface.
type Logger interface{ Log() }

// ReadWriter embeds two interfaces and adds a method.
type ReadWriter interface {
	Store
	Logger
	Flush()
}

// Svc embeds two interfaces: each method is declared by exactly one of them.
type Svc struct {
	Store
	Logger
}

// Base is a struct embedded beside an interface.
type Base struct{}

// Foo is only on Base.
func (Base) Foo() {}

// Both embeds an interface and a struct.
type Both struct {
	Store
	Base
}

// Wide embeds an interface that embeds interfaces, beside a struct.
type Wide struct {
	ReadWriter
	Base
}

// PtrEmbed embeds a pointer.
type PtrEmbed struct{ *F }

// X1 declares Pick at depth 1 of Chooser; X3 at depth 2.
type X1 struct{}

// Pick is the shallow one.
func (X1) Pick() {}

// X3 declares Pick deeper.
type X3 struct{}

// Pick is the deep one.
func (X3) Pick() {}

// Only is declared only at depth 2.
func (X3) Only() {}

// X2 embeds X3.
type X2 struct{ X3 }

// Chooser reaches Pick at two depths.
type Chooser struct {
	X1
	X2
}

// Shadow declares its own Pick over an embedded one.
type Shadow struct{ X1 }

// Pick is Shadow's own.
func (Shadow) Pick() {}

// FieldWins has a FIELD named like a promoted method's holder.
type FieldWins struct {
	X1
	Run func()
}

// Far reaches model.Base at depth 2 and its own Base at depth 1; a third Hello
// sits at depth 3, where it must lose to model's.
type Far struct {
	Base
	Mid2
	Deep3
}

// Mid2 embeds model.Base.
type Mid2 struct{ model.Base }

// Deep3 puts a Hello at depth 3.
type Deep3 struct{ Deep3a }

// Deep3a embeds Deep3b.
type Deep3a struct{ Deep3b }

// Deep3b declares the deepest Hello.
type Deep3b struct{}

// Hello is the depth-3 one.
func (Deep3b) Hello() {}

// OverModel is a defined type over a struct of another package.
type OverModel model.Holder

// AliasEmbed embeds through an alias.
type AliasEmbed struct{ model.Alias }

func chain(s S, ps *S) {
	s.M()
	s.Deep()
	s.Mid()
	s.Own()
	ps.M()
	s.E.M()
	s.E.F.Deep()
}

func interfaces(svc Svc, both Both, wide Wide, rw ReadWriter) {
	svc.Save()
	svc.Log()
	both.Save()
	both.Foo()
	wide.Flush()
	wide.Foo()
	wide.Log()
	rw.Save()
	rw.Flush()
}

func depths(c Chooser, sh Shadow, pe PtrEmbed, fw FieldWins) {
	c.Pick()
	c.Only()
	sh.Pick()
	sh.X1.Pick()
	pe.M()
	fw.Pick()
	fw.Run()
}

func across(far Far, om OverModel, ae AliasEmbed) {
	far.Hello()
	far.Foo()
	om.Base.Hello()
	ae.Run()
	ae.Stop()
}
