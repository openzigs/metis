//go:build ignore

// A generator beside a library: `go run gen.go`. It is a single-file package
// of its own, never part of package gen.
package main

import (
	"fmt"

	"example.com/app/model"
)

func main() {
	emit()
	fmt.Println(render())
	model.NewThing().Run()
}

func emit() {}

func render() string { return "" }
