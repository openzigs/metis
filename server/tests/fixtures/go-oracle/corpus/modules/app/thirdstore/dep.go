// Package thirdstore: a dependency beside a project package of the same
// name. Its import path is not inside this module, however it ends.
package thirdstore

import "github.com/acme/storage"

func viaDependency(c storage.Conn) {
	storage.Save()
	c.Ping()
}
