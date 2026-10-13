// Package twintest: a helper that only `_test.go` files declare, once per
// platform. Inside a twin the caller's own file declares the callee.
package twintest

// Base ships.
func Base() {}
