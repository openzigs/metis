// Package values: what is called is a VALUE — a func-typed variable, field,
// parameter or result, a method value — or a type (a conversion).
package values

import "example.com/app/model"

// Op is a func type.
type Op func() *model.Thing

// Table holds funcs in fields.
type Table struct {
	Make  func() *model.Thing
	Named Op
	Ops   []Op
	ByKey map[string]Op
}

// Celsius is a defined numeric type.
type Celsius float64

// String is declared on a defined basic type.
func (Celsius) String() string { return "" }

// run is a package function; `runner` is a variable holding it.
func run() *model.Thing { return nil }

var runner = run

var op Op

// Run is a FUNCTION named like model.Thing's method.
func Run() {}

func fields(t Table) {
	t.Make().Run()
	t.Named().Stop()
	t.Ops[0]().Run()
	t.ByKey["k"]().Stop()
}

func variables() {
	runner().Run()
	op().Stop()
	f := run
	f().Run()
	g := model.NewThing
	g().Stop()
}

func params(mk func() *model.Thing, o Op) {
	mk().Run()
	o().Stop()
}

func methodValues(t model.Thing) {
	bound := t.Run
	bound()
	expr := model.Thing.Run
	expr(t)
	(&t).Stop()
	stop := (*model.Thing).Stop
	stop(&t)
}

func conversions(f float64) {
	c := Celsius(f)
	_ = c.String()
	_ = float64(c)
	_ = Op(run)
	_ = []byte("x")
	_ = model.List(nil)
	_ = (*model.Thing)(nil)
	Run()
}

func returnsFunc() func() *model.Thing { return run }

func results() {
	returnsFunc()().Run()
	h := returnsFunc()
	h().Stop()
}
