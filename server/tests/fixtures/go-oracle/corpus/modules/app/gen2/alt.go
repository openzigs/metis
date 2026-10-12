//go:build ignore

package gen2

func emit() {}

// Alt is only ever built on its own (`go vet alt.go`).
func Alt() {
	emit()
}
