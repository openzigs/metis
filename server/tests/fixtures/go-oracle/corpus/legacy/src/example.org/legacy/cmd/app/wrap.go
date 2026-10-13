package main

import "github.com/pkg/errors"

// wrap calls the DEPENDENCY: a tree with no go.mod that also holds a directory
// `pkg/errors` (PR #1104, review cycle 5).
func wrap() {
	errors.Wrap()
}
