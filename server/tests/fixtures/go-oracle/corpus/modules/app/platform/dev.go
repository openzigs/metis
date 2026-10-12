package platform

// Dev is declared once; its method Reset is declared once per platform.
type Dev struct{}

// Restart calls a method three files declare.
func Restart(d Dev) {
	d.Reset()
	d.Name()
}

// Name is declared once.
func (Dev) Name() string { return "" }
