// Command go-stdlib-snapshot prints, as JSON, what the METIS Go type resolver
// has to know about the standard library without reading it (#1071):
//
//   - packages:         every public standard-library import path (`go list std`
//     over the listed platforms, so `syscall/js` is there whatever the host is);
//   - interfaces:       every exported interface type, by import path;
//   - interfaceMembers: for every exported non-generic concrete type, the
//     exported fields whose type is an exported standard-library interface
//     (`Body`), and the methods that return one, with the result positions
//     (`Context(0)`);
//   - interfaceVars:    exported package-level variables of such a type
//     (`io.Discard`).
//
// The output is checked in as
// `server/src/lib/code-graph/go-stdlib.snapshot.json`; a test compares the lists
// in `go-stdlib.ts` with it and never runs Go. Regenerate with
// `scripts/gen-go-stdlib-snapshot.sh` when moving to a new Go release.
//
// Only the standard library is imported, and nothing is written but stdout.
package main

import (
	"encoding/json"
	"fmt"
	"go/importer"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
)

// platforms whose `go list std` output is merged: a package that exists on any
// of them is a standard-library import path.
var platforms = [][2]string{
	{runtime.GOOS, runtime.GOARCH},
	{"linux", "amd64"},
	{"windows", "amd64"},
	{"darwin", "arm64"},
	{"js", "wasm"},
	{"wasip1", "wasm"},
}

type snapshot struct {
	GoVersion        string              `json:"goVersion"`
	Packages         []string            `json:"packages"`
	Interfaces       map[string][]string `json:"interfaces"`
	InterfaceMembers map[string][]string `json:"interfaceMembers"`
	InterfaceVars    map[string][]string `json:"interfaceVars"`
	// Packages the host could not type-check (they build on another platform
	// only): listed in Packages, with no interface facts.
	Unchecked []string `json:"unchecked"`
}

func public(path string) bool {
	for _, seg := range strings.Split(path, "/") {
		if seg == "internal" || seg == "vendor" {
			return false
		}
	}
	return true
}

func listStd(goos, goarch string) ([]string, error) {
	cmd := exec.Command("go", "list", "std")
	// Listing needs no C compiler, and with cgo off `runtime/cgo` is not listed.
	cgo := "0"
	if goos == runtime.GOOS && goarch == runtime.GOARCH {
		cgo = "1"
	}
	cmd.Env = append(os.Environ(), "GOOS="+goos, "GOARCH="+goarch, "CGO_ENABLED="+cgo)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("go list std (%s/%s): %w", goos, goarch, err)
	}
	return strings.Fields(string(out)), nil
}

// stdInterface reports whether t is an exported interface type declared in the
// standard library — the only kind this snapshot records. `error` and `any`
// are predeclared, not standard-library types, and are left out on purpose.
func stdInterface(t types.Type) bool {
	if _, isParam := t.(*types.TypeParam); isParam {
		return false
	}
	named, ok := types.Unalias(t).(*types.Named)
	if !ok || named.Obj().Pkg() == nil || !named.Obj().Exported() {
		return false
	}
	return types.IsInterface(named)
}

func main() {
	seen := map[string]bool{}
	for _, p := range platforms {
		paths, err := listStd(p[0], p[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		for _, path := range paths {
			if public(path) {
				seen[path] = true
			}
		}
	}
	snap := snapshot{
		GoVersion:        runtime.Version(),
		Interfaces:       map[string][]string{},
		InterfaceMembers: map[string][]string{},
		InterfaceVars:    map[string][]string{},
		Unchecked:        []string{},
	}
	for path := range seen {
		snap.Packages = append(snap.Packages, path)
	}
	sort.Strings(snap.Packages)

	imp := importer.ForCompiler(token.NewFileSet(), "source", nil)
	for _, path := range snap.Packages {
		if path == "unsafe" {
			continue
		}
		pkg, err := imp.Import(path)
		if err != nil {
			snap.Unchecked = append(snap.Unchecked, path)
			continue
		}
		scope := pkg.Scope()
		for _, name := range scope.Names() {
			obj := scope.Lookup(name)
			if !obj.Exported() {
				continue
			}
			switch o := obj.(type) {
			case *types.Var:
				if stdInterface(o.Type()) {
					snap.InterfaceVars[path] = append(snap.InterfaceVars[path], name)
				}
			case *types.TypeName:
				if types.IsInterface(o.Type()) {
					snap.Interfaces[path] = append(snap.Interfaces[path], name)
					continue
				}
				named, ok := types.Unalias(o.Type()).(*types.Named)
				// A generic type's members may mention its type arguments; the
				// resolver leaves those undecided anyway.
				if !ok || named.TypeParams().Len() > 0 || named.Obj().Pkg() != pkg {
					continue
				}
				var members []string
				if st, isStruct := named.Underlying().(*types.Struct); isStruct {
					for i := 0; i < st.NumFields(); i++ {
						f := st.Field(i)
						if f.Exported() && stdInterface(f.Type()) {
							members = append(members, f.Name())
						}
					}
				}
				set := types.NewMethodSet(types.NewPointer(named))
				for i := 0; i < set.Len(); i++ {
					fn, isFunc := set.At(i).Obj().(*types.Func)
					if !isFunc || !fn.Exported() {
						continue
					}
					results := fn.Type().(*types.Signature).Results()
					var at []string
					for r := 0; r < results.Len(); r++ {
						if stdInterface(results.At(r).Type()) {
							at = append(at, fmt.Sprint(r))
						}
					}
					if len(at) > 0 {
						members = append(members, fn.Name()+"("+strings.Join(at, ",")+")")
					}
				}
				if len(members) > 0 {
					sort.Strings(members)
					snap.InterfaceMembers[path+"."+name] = members
				}
			}
		}
	}
	sort.Strings(snap.Unchecked)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	if err := enc.Encode(snap); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
