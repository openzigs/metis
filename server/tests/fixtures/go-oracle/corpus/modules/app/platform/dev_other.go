//go:build !linux && !windows

package platform

// Reset is the one for every other platform.
func (Dev) Reset() {}
