// Command app of the legacy tree.
package main

import (
	bstore "example.org/legacy/b/store"
	"example.org/legacy/mystore"
	own "example.org/legacy/store"
	zstore "example.org/legacy/zx/ab/store"
	dep "store"
	ext "x/ab/store"
)

func main() {
	own.Save()
	bstore.Save()
	mystore.Save()
	zstore.Save()
	dep.Save()
	ext.Save()
	local()
}

func local() {}
