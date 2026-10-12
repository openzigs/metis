package embed

import "testing"

func TestPromotion(t *testing.T) {
	var s S
	s.M()
	s.Deep()
	s.Reset()
	s.Probe2()
	Helper().M()
	var to TestOnly
	to.M()
	to.Probe()
	to.Mid()
	t.Log("ok")
}

func TestChooser(t *testing.T) {
	var c Chooser
	c.Pick()
	chain(S{}, nil)
}
