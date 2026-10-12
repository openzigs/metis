package values

// Made is what a Factory makes.
type Made struct{}

// Save is Made's method.
func (*Made) Save() {}

// Factory is an ALIAS of a func type: a call of a value of it returns a *Made.
type Factory = func() *Made

// Opts is an ALIAS of a struct type written in place.
type Opts = struct{ M *Made }

// router holds a slice of func values behind a field.
type router struct{ handlers []func(int) *Made }

func viaFactory(f Factory) {
	f().Save()
}

func viaOpts(o Opts) {
	o.M.Save()
}

func (s *router) dispatch(i int) {
	s.handlers[i](1)
	s.handlers[i](2).Save()
}
