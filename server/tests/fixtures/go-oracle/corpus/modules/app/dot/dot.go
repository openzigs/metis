// Package dot: a dot import puts another package's names in this file's scope.
package dot

import (
	. "example.com/app/model"
	. "unicode/utf8"
)

// local is this package's own function.
func local() *Thing { return nil }

func use() {
	NewThing().Run()
	New().Run()
	local().Stop()
	Default.Run()
	_ = ValidString("x")
	var l List
	l[0].Run()
	_ = Thing(Alias{})
}
