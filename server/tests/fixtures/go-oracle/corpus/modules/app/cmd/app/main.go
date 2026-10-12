// Command app is a `package main` inside the module.
package main

import (
	"fmt"
	"os"

	"example.com/app/embed"
	"example.com/app/gen"
	"example.com/app/generics"
	"example.com/app/model"
	"example.com/app/platform"
)

type app struct {
	thing *model.Thing
	svc   embed.Svc
	out   *os.File
}

func newApp() *app { return &app{} }

func (a *app) run() error {
	a.thing.Run()
	a.svc.Save()
	a.out.Close()
	return nil
}

func main() {
	a := newApp()
	if err := a.run(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
	gen.Emit()
	fmt.Println(platform.Start())
	model.NewThing().Stop()
	_ = generics.First[int]([]int{1})
	_ = generics.Scale[int](1)
}
