// Command svc1: `app/storage` is THIS module's storage, whatever the
// neighbouring module calls itself.
package main

import "app/storage"

func main() {
	storage.Open().Ping()
}
