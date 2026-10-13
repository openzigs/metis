// Package service declares types with the SAME NAMES as package model and
// reaches model's through every kind of declaration. Each call below must bind
// the method of the type the DECLARING file names, never this package's twin.
package service

import "example.com/app/model"

// Thing is this package's own Thing.
type Thing struct{}

// Run is service.Thing's.
func (Thing) Run() {}

// Stop is service.Thing's.
func (Thing) Stop() {}

// Other is what this package's composites hold.
type Other struct{}

// Run is service.Other's.
func (Other) Run() {}

// Inner has the field model.Inner has, of another type.
type Inner struct{ F *Other }

// Base has the method model.Base has.
type Base struct{}

// Hello is service.Base's.
func (Base) Hello() {}

// List is this package's own named slice.
type List []*Other

// Maker is this package's own func type.
type Maker func() *Other

func use(m model.Maker, l model.List, al model.Alias, w model.Wrapped, h model.Holder) {
	m().Run()
	l[0].Run()
	al.Run()
	w.F.Run()
	h.Hello()
}

func useVars() {
	model.Default.Run()
	model.Factory().Run()
	model.Shared.Stop()
	model.Pool[0].Run()
	model.First.Stop()
	model.Second.Hello()
}

func useResults() {
	model.New().Run()
	model.NewThing().Stop()
	model.NewPool()[0].Run()
	model.Anon().Run()
}

func useComposites(ls model.Lists, idx model.Index, feed model.Feed) {
	ls[0].Run()
	idx["k"].Stop()
	v := <-feed
	v.Run()
}

func two(x Thing, y model.Thing) {
	x.Run()
	y.Run()
	x.Stop()
	y.Stop()
}

func own(l List, m Maker, in Inner, b Base) {
	l[0].Run()
	m().Run()
	in.F.Run()
	b.Hello()
}

func viaExpr(t model.Thing) {
	model.Thing.Run(t)
	f := model.NewThing
	f().Run()
	_ = Thing(struct{}{})
	_ = model.Wrapped(model.Inner{})
}
