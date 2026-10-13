// Package platform: build-constraint twins. Which twin a call reaches depends
// on the platform, which no reader of the source alone can settle — except
// inside a twin, where the caller's own file declares the callee.
package platform

// Start calls a function that three files declare, one per platform.
func Start() string {
	return initPlatform()
}

// Dial calls a method of a type two files declare.
func Dial(c Conn) {
	c.Open()
	always()
}

func always() {}

// Hooked calls the result of a value whose type two files declare.
func Hooked(h Hook) {
	h().Name()
}
