package dot

import . "unicode/utf8"

// A file with ONE dot import, of a package outside the project.
func single() int {
	_ = len("x")
	return RuneLen('x')
}
