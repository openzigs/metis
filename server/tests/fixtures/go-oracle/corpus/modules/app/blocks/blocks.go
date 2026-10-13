// Package blocks: `:=` declares only the names new in its scope, and every
// block form — if, switch, type switch, select, for, range, defer, go — opens
// one. P and Q both declare Do, so a variable given the wrong scope binds a
// wrong method.
package blocks

// P is the outer type in most probes.
type P struct{}

// Do is P's.
func (P) Do() {}

// Q is the inner type.
type Q struct{}

// Do is Q's.
func (Q) Do() {}

// Doer is what a type switch narrows.
type Doer interface{ Do() }

// NewP returns a P.
func NewP() *P { return nil }

// NewQ returns a Q.
func NewQ() *Q { return nil }

// PQ returns one of each.
func PQ() (*P, *Q) { return nil, nil }

// QErr returns a Q and an error.
func QErr() (*Q, error) { return nil, nil }

// PErr returns a P and an error.
func PErr() (*P, error) { return nil, nil }

func ifForm(flag bool) {
	x := NewP()
	if x := NewQ(); flag {
		x.Do()
	} else {
		x.Do()
	}
	x.Do()
}

func ifElseChain(flag bool) {
	x := NewP()
	if y := NewQ(); flag {
		y.Do()
	} else if x := y; !flag {
		x.Do()
	} else {
		x.Do()
	}
	x.Do()
}

func ifBody(flag bool) {
	x := NewP()
	if flag {
		x := NewQ()
		x.Do()
	}
	x.Do()
}

func switchForm(n int) {
	x := NewP()
	switch x := NewQ(); n {
	case 0:
		x.Do()
	default:
		x := NewP()
		x.Do()
	}
	x.Do()
}

func switchCases(n int) {
	x := NewP()
	switch {
	case n == 0:
		x := NewQ()
		x.Do()
	case n == 1:
		x.Do()
	default:
		x.Do()
	}
}

func typeSwitch(d Doer) {
	switch v := d.(type) {
	case *P:
		v.Do()
	case *Q:
		v.Do()
	case nil:
	case interface{ Other() }:
		v.Other()
	default:
		v.Do()
	}
}

func typeSwitchTwo(d Doer) {
	v := NewP()
	switch v := d.(type) {
	case *P, *Q:
		v.Do()
	}
	v.Do()
}

func typeSwitchInit() {
	v := NewQ()
	switch d := Doer(NewP()); v := d.(type) {
	case *P:
		v.Do()
	}
	v.Do()
}

func selectForm(pc chan *P, qc chan *Q) {
	v := NewP()
	select {
	case v := <-qc:
		v.Do()
	case w, ok := <-pc:
		_ = ok
		w.Do()
	default:
		v.Do()
	}
	v.Do()
}

func selectAssign(pc chan *P, qc chan *Q) {
	var v *P
	select {
	case v = <-pc:
		v.Do()
	case q := <-qc:
		q.Do()
	}
}

func forForm() {
	v := NewP()
	for v := NewQ(); v != nil; v = nil {
		v.Do()
	}
	v.Do()
	for i := 0; i < 1; i++ {
		v := NewQ()
		v.Do()
	}
	v.Do()
}

func rangeForm(ps []*P, qm map[string]*Q, pch chan *P, pm map[*P]*Q) {
	v := NewQ()
	for _, v := range ps {
		v.Do()
	}
	v.Do()
	for name, v := range qm {
		_ = name
		v.Do()
	}
	for v := range pch {
		v.Do()
	}
	for i := range ps {
		ps[i].Do()
	}
	for key, val := range pm {
		key.Do()
		_ = val
	}
	for k := range pm {
		k.Do()
	}
}

func rangeAssign(ps []*P) {
	var v *P
	for _, v = range ps {
		v.Do()
	}
}

func deferGo() {
	v := NewP()
	defer v.Do()
	go v.Do()
	defer NewQ().Do()
	defer func() {
		v := NewQ()
		v.Do()
	}()
	go func(v *Q) {
		v.Do()
	}(nil)
}

func bareBlock() {
	v := NewP()
	{
		v := NewQ()
		v.Do()
	}
	v.Do()
}

func redeclare() {
	x, err := QErr()
	_ = err
	y, err := PErr()
	_ = err
	x.Do()
	y.Do()
}

func redeclareKeepsParam(x *P) {
	x, y := NewP(), NewQ()
	x.Do()
	y.Do()
}

func redeclareInner() {
	x, err := QErr()
	_ = err
	if true {
		x, err := PErr()
		_ = err
		x.Do()
	}
	x.Do()
}

func multi() {
	a, b := PQ()
	a.Do()
	b.Do()
	c, d := NewQ(), NewP()
	c.Do()
	d.Do()
}

func swap() {
	a, b := NewP(), NewQ()
	a2, b2 := b, a
	a2.Do()
	b2.Do()
	p1 := NewP()
	p2 := NewP()
	p1, p2 = p2, p1
	p1.Do()
	p2.Do()
}

func varForms() {
	var a *P
	var b = NewQ()
	var c, d = PQ()
	var (
		e    *Q
		f, g = NewP(), NewQ()
	)
	a.Do()
	b.Do()
	c.Do()
	d.Do()
	e.Do()
	f.Do()
	g.Do()
}

func assignKeepsWritten() {
	var d Doer = NewP()
	d.Do()
	d = NewQ()
	d.Do()
}

func assignInferred() {
	x := NewP()
	x = NewP()
	x.Do()
	var y *Q
	y = NewQ()
	y.Do()
}

func labelled(ps []*P) {
outer:
	for _, v := range ps {
		for _, v := range []*Q{nil} {
			v.Do()
			continue outer
		}
		v.Do()
	}
}

func commaOk(m map[string]*P, d Doer) {
	v, ok := m["k"]
	_ = ok
	v.Do()
	q, ok := d.(*Q)
	_ = ok
	q.Do()
}

func localType() {
	type P struct{ Q }
	var v P
	v.Do()
	_ = P(v)
}

func localShadowsFunc() {
	NewP := func() *Q { return nil }
	NewP().Do()
}
