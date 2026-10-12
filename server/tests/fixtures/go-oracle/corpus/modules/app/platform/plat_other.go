//go:build !linux && !windows

package platform

func initPlatform() string {
	return helper()
}

func helper() string {
	return shared()
}
