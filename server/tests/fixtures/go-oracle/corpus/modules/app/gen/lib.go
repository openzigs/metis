// Package gen is the library the generator sits beside. Its `emit` is not the
// generator's.
package gen

// Emit is what an importer of this directory calls.
func Emit() {
	emit()
	render()
}

func emit() {}

func render() {}
