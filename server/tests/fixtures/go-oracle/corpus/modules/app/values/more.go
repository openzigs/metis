package values

import "example.com/app/model"

// Level is a defined type with typed constants.
type Level int

// Name is declared on the constants' type.
func (Level) Name() string { return "" }

// Low is typed where it is written; High repeats it.
const (
	Low Level = iota
	High
)

// Fixed is typed by a conversion.
const Fixed = Level(3)

// NewCelsius returns a defined numeric type.
func NewCelsius() Celsius { return 0 }

// choose returns its argument: its result has no written type.
func choose[F any](f F) F { return f }

// chosen is a package variable whose type nothing here can tell.
var chosen = choose(run)

// anyRunner is a package variable of an interface type written in place, with
// an initialiser of a concrete type.
var anyRunner interface{ Run() } = model.Thing{}

func consts() {
	_ = Low.Name()
	_ = High.Name()
	_ = Fixed.Name()
}

func compound() {
	c := NewCelsius()
	c += 1
	_ = c.String()
}

func viaChosen() {
	chosen().Run()
	anyRunner.Run()
}

func negated() {
	c := NewCelsius()
	c = -c
	_ = c.String()
}
