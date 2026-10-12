package blocks

// pick returns a value of its type parameter: its result has no written type.
func pick[T any](v T) T { return v }

// NewDoer returns an interface value.
func NewDoer() Doer { return NewP() }

// NewChan returns a channel of P.
func NewChan() chan *P { return nil }

// NewPs returns a slice of P.
func NewPs() []*P { return nil }

func name() string { return "" }

func redeclareKeepsWrittenParam(x *P) {
	x, y := pick(x), NewQ()
	x.Do()
	y.Do()
}

func rangeOverCall() {
	for _, v := range NewPs() {
		v.Do()
	}
}

func rangeAssignInterface(ps []*P) {
	var d Doer
	for _, d = range ps {
		d.Do()
	}
}

func receiveAssignInterface(pc chan *P) {
	var d Doer
	select {
	case d = <-pc:
		d.Do()
	}
}

func receiveFromCall() {
	select {
	case v := <-NewChan():
		v.Do()
	}
}

func typeSwitchOnCall() {
	switch v := NewDoer().(type) {
	case *Q:
		v.Do()
	}
}

func typeSwitchNoAlias(d Doer) {
	switch d.(type) {
	case *P:
		NewP().Do()
	}
}

func localVarUnmodelled() {
	var h interface{ Do() } = NewP()
	h.Do()
}

func localVarShadowsFunc() {
	var NewQ = func() *P { return nil }
	NewQ().Do()
}

func localAlias() {
	type P = Q
	var v P
	v.Do()
}

func builtins() {
	new(P).Do()
	make([]*Q, 1)[0].Do()
	append([]*P{}, nil)[0].Do()
	ps := make(map[string]*P)
	ps["k"].Do()
}

func conversionOperand() {
	_ = []byte(name())
}

func indexedLocal(hs []func() *P) {
	hs[0]().Do()
}

func compoundAssign() {
	v := NewP()
	n := 0
	n += 1
	_ = n
	v.Do()
}
