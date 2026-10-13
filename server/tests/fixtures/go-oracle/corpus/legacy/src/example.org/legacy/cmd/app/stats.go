package main

import "appstats"

// stats calls the DEPENDENCY `appstats`: a tree with no go.mod whose only
// directory of that name sits at the project's own root (PR #1104, review
// cycle 7).
func stats() {
	appstats.Main()
}
