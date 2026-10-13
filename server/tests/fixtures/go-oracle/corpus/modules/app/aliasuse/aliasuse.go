// Package aliasuse: import aliases, and a local that hides a package name.
package aliasuse

import (
	"example.com/app/gen"
	m "example.com/app/model"
	svc "example.com/app/service"
)

type localThing struct{}

// NewThing is a METHOD named like model's function.
func (localThing) NewThing() *svc.Thing { return nil }

// Emit is a method named like gen's function.
func (localThing) Emit() {}

func aliases(a m.Thing, b svc.Thing) {
	a.Run()
	b.Run()
	m.NewThing().Stop()
	gen.Emit()
}

func shadow() {
	m.NewThing().Run()
	m := localThing{}
	m.NewThing().Run()
	gen := m
	gen.Emit()
}

func shadowParam(gen localThing, svc m.Maker) {
	gen.Emit()
	svc().Run()
}

func shadowInBlock(flag bool) {
	if flag {
		m := localThing{}
		m.NewThing().Stop()
	}
	m.NewThing().Stop()
}
