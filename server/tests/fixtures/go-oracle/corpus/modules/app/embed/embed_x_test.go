package embed_test

import (
	"testing"

	"example.com/app/embed"
)

type local struct{ embed.S }

func TestExternal(t *testing.T) {
	var s embed.S
	s.M()
	s.Mid()
	s.Reset()
	embed.Helper().Deep()
	var l local
	l.M()
	l.Own()
	t.Log("ok")
}
