package dot

// A file of the same package WITHOUT the dot import: model's names are not in
// its scope.
func plain() {
	local().Run()
}
