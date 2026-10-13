// Command svc2: `app/storage` is THIS module's storage.
package main

import "app/storage"

func main() {
	storage.Open().Ping()
}
