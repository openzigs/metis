// Command tool is in a SECOND module that imports the first: one import path
// per module, and two packages named model.
package main

import (
	appmodel "example.com/app/model"
	"example.com/app/service"
	"example.com/tools/model"
)

func main() {
	model.NewThing().Run()
	appmodel.NewThing().Stop()
	var own model.Thing
	own.Run()
	var theirs appmodel.Thing
	theirs.Run()
	var svc service.Thing
	svc.Stop()
	appmodel.Default.Run()
}
