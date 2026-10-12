package thirdstore

import "example.com/app/storage"

func viaProject(c storage.Conn) {
	storage.Save()
	c.Ping()
}
