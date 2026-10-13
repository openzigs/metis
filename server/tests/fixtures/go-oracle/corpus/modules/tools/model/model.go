// Package model is the tools module's OWN package model: the same package
// name, and the same type and method names, as example.com/app/model.
package model

// Thing is tools' Thing.
type Thing struct{}

// Run is tools' Thing.Run.
func (Thing) Run() {}

// Stop is tools' Thing.Stop.
func (*Thing) Stop() {}

// NewThing returns tools' Thing.
func NewThing() *Thing { return nil }
