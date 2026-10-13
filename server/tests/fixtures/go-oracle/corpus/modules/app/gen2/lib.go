// Package gen2 holds a build-ignored file with the SAME package clause as the
// library: its `emit` is still not the library's.
package gen2

func emit() {}

// Use calls the library's emit from the file that declares it.
func Use() {
	emit()
}
