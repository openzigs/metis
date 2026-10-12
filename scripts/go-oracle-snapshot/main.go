// Command go-oracle-snapshot prints, as JSON, what the Go TYPE CHECKER says
// about every call expression of the Go corpus under
// `server/tests/fixtures/go-oracle/` (#1071).
//
// The METIS Go resolver binds a call to the function it statically reaches
// from what the source declares, without a type checker. Whether it binds the
// RIGHT function is not something hand-written fixtures could keep pinned:
// three mutation passes in a row found new one-edit mutants that bound a wrong
// target with every suite green (PR #1104). So the expected answer is not
// written by hand any more. This program loads the corpus the way the go tool
// builds it and records, for every call:
//
//   - `func`: the project function or method it statically resolves to, named
//     by the file that declares it, the receiver type as written, and its name;
//   - or why it has none: `interface` (dispatched at run time through an
//     interface or a type parameter), `func-value` (a variable, field,
//     parameter or result holding a function), `conversion`, `builtin`, or
//     `external` (a function or concrete method of the standard library or of
//     a dependency);
//   - `build-dependent` when the platforms listed below disagree — twins
//     behind build constraints.
//
// It also lists every function, method and type the corpus DECLARES, with the
// lines it spans: the symbols the walker must record.
//
// A vitest suite compares that with what the tree-sitter walker, the resolver
// and ingest produce (`server/tests/lib/code-graph/go-oracle-corpus.test.ts`),
// and never runs Go. The output is checked in as
// `server/tests/fixtures/go-oracle/oracle.snapshot.json`; regenerate it with
// `node scripts/gen-go-oracle-snapshot.mjs` whenever the corpus changes (a
// drift test fails until then).
//
// How the corpus is loaded. `go list -deps -test -json ./...` names the files
// of every package for one platform; each package is then type-checked from
// source with go/types, three ways where it applies: the package itself, the
// package with its `_test.go` files, and its external `_test` package against
// that. A file excluded on EVERY platform (`//go:build ignore`) is checked as
// the single-directory program `go run` would build from it. Any type error is
// fatal: the corpus must compile.
//
// Only the standard library is imported, and nothing is written but stdout.
// Nothing in the build, the tests or CI runs this.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/printer"
	"go/token"
	"go/types"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// platforms the corpus is type-checked for. A call whose answer differs
// between them is `build-dependent`.
var platforms = [][2]string{
	{"linux", "amd64"},
	{"windows", "amd64"},
	{"darwin", "arm64"},
}

// treeConfig is one entry of the fixture's `trees.json`.
type treeConfig struct {
	Name string `json:"name"`
	// Root is the directory METIS is given, relative to the fixture: a
	// function declared under it is a PROJECT function.
	Root string `json:"root"`
	// Mode is "modules" (every go.mod under Root is loaded) or "gopath"
	// (no go.mod: GO111MODULE=off with Gopath as GOPATH).
	Mode   string   `json:"mode"`
	Gopath []string `json:"gopath,omitempty"`
}

type fnRef struct {
	File string `json:"file"`
	// Recv is the receiver's base type name as written; empty for a function.
	Recv string `json:"recv,omitempty"`
	Name string `json:"name"`
}

type answer struct {
	K      string  `json:"k"`
	Target *fnRef  `json:"target,omitempty"`
	Origin string  `json:"origin,omitempty"`
	Detail string  `json:"detail,omitempty"`
	Per    []perOS `json:"per,omitempty"`
}

type perOS struct {
	OS     string `json:"os"`
	Answer answer `json:"answer"`
}

type site struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
	// Callee is the called expression as written.
	Callee string `json:"callee"`
	// Form is how the callee is spelled: a bare identifier, a selector, or
	// anything else (a parenthesised expression, an index, a func literal).
	Form string `json:"form"`
	// Name is the called identifier for the first two forms.
	Name string `json:"name,omitempty"`
	// From is the declared function the call is written in; absent at
	// package level.
	From   *fnRef `json:"from,omitempty"`
	Answer answer `json:"answer"`
	// Only lists the platforms the file is built for, when not all of them.
	Only []string `json:"only,omitempty"`
}

// symbol is one declaration: a function or method, or a type that is not an
// alias (wherever it is declared — a type inside a function is one too).
type symbol struct {
	File string `json:"file"`
	// Kind is `function`, or for a type what it is declared as: `struct`,
	// `interface` or `type`.
	Kind string `json:"kind"`
	// Recv is the receiver's base type name for a method.
	Recv    string `json:"recv,omitempty"`
	Name    string `json:"name"`
	Line    int    `json:"line"`
	EndLine int    `json:"endLine"`
}

type treeOut struct {
	Name    string   `json:"name"`
	Root    string   `json:"root"`
	Calls   []site   `json:"calls"`
	Symbols []symbol `json:"symbols"`
}

type snapshot struct {
	GoVersion string    `json:"goVersion"`
	Platforms []string  `json:"platforms"`
	Trees     []treeOut `json:"trees"`
}

type listPkg struct {
	ImportPath     string
	Dir            string
	Name           string
	Standard       bool
	ForTest        string
	GoFiles        []string
	TestGoFiles    []string
	XTestGoFiles   []string
	IgnoredGoFiles []string
	Error          *struct{ Err string }
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "go-oracle-snapshot: "+format+"\n", args...)
	os.Exit(1)
}

// loader is shared by every tree: one file set, each file parsed once.
type loader struct {
	fset   *token.FileSet
	parsed map[string]*ast.File
	std    types.Importer
	goroot string
}

func (l *loader) parse(path string) *ast.File {
	if f, ok := l.parsed[path]; ok {
		return f
	}
	f, err := parser.ParseFile(l.fset, path, nil, parser.ParseComments|parser.SkipObjectResolution)
	if err != nil {
		fatal("parse %s: %v", path, err)
	}
	l.parsed[path] = f
	return f
}

// universe is one module (or GOPATH tree) on one platform.
type universe struct {
	l     *loader
	goos  string
	pkgs  map[string]*listPkg
	plain map[string]*types.Package
	// override, when set, replaces one import path: an external test package
	// imports its package's TEST variant.
	override map[string]*types.Package
}

func (u *universe) Import(path string) (*types.Package, error) {
	if path == "unsafe" {
		return types.Unsafe, nil
	}
	if p, ok := u.override[path]; ok {
		return p, nil
	}
	lp := u.pkgs[path]
	if lp == nil || lp.Standard {
		return u.l.std.Import(path)
	}
	if p, ok := u.plain[path]; ok {
		return p, nil
	}
	p, _ := u.check(lp.ImportPath, lp.Dir, lp.GoFiles)
	u.plain[path] = p
	return p, nil
}

func (u *universe) check(importPath, dir string, names []string) (*types.Package, *types.Info) {
	files := make([]*ast.File, 0, len(names))
	for _, n := range names {
		files = append(files, u.l.parse(filepath.Join(dir, n)))
	}
	info := &types.Info{
		Types:      map[ast.Expr]types.TypeAndValue{},
		Uses:       map[*ast.Ident]types.Object{},
		Defs:       map[*ast.Ident]types.Object{},
		Selections: map[*ast.SelectorExpr]*types.Selection{},
		Instances:  map[*ast.Ident]types.Instance{},
	}
	conf := types.Config{
		Importer: u,
		Error: func(err error) {
			fatal("type error (%s, %s): %v", importPath, u.goos, err)
		},
	}
	pkg, err := conf.Check(importPath, u.l.fset, files, info)
	if err != nil {
		fatal("check %s (%s): %v", importPath, u.goos, err)
	}
	return pkg, info
}

func goList(dir string, env []string) []*listPkg {
	cmd := exec.Command("go", "list", "-e", "-deps", "-test", "-json", "./...")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		fatal("go list in %s: %v\n%s", dir, err, stderr.String())
	}
	var pkgs []*listPkg
	dec := json.NewDecoder(bytes.NewReader(out))
	for dec.More() {
		p := &listPkg{}
		if err := dec.Decode(p); err != nil {
			fatal("go list output in %s: %v", dir, err)
		}
		// The synthesised test binaries and the recompiled test variants are
		// rebuilt here from the plain entries.
		if p.ForTest != "" || strings.HasSuffix(p.ImportPath, ".test") || strings.Contains(p.ImportPath, " [") {
			continue
		}
		if p.Error != nil && !p.Standard {
			fatal("go list %s in %s: %s", p.ImportPath, dir, p.Error.Err)
		}
		pkgs = append(pkgs, p)
	}
	return pkgs
}

// recorder collects the call sites of one tree.
type recorder struct {
	l       *loader
	fixture string
	root    string
	// decls: file and byte offset of a declared function's name → what METIS
	// calls it.
	decls map[string]*fnRef
	// sites: file:offset → platform → site.
	sites map[string]map[string]*site
	// compiled / ignored: files seen in a package's file list, or in its
	// ignored list, on some platform.
	compiled map[string]bool
	ignored  map[string]string
	// symbols: every declaration of the tree's files, once per file.
	symbols []symbol
	indexed map[string]bool
}

func (r *recorder) rel(path string) string {
	rel, err := filepath.Rel(r.fixture, path)
	if err != nil {
		fatal("rel %s: %v", path, err)
	}
	return filepath.ToSlash(rel)
}

func (r *recorder) inRoot(path string) bool {
	return path == r.root || strings.HasPrefix(path, r.root+string(filepath.Separator))
}

// origin says where a declaration lives: the project, the standard library,
// a dependency, or nowhere (a predeclared object).
func (r *recorder) origin(pos token.Pos) string {
	if !pos.IsValid() {
		return "universe"
	}
	name := r.l.fset.Position(pos).Filename
	switch {
	case r.inRoot(name):
		return "project"
	case strings.HasPrefix(name, r.l.goroot+string(filepath.Separator)):
		return "stdlib"
	default:
		return "dependency"
	}
}

func declKey(fset *token.FileSet, pos token.Pos) string {
	p := fset.Position(pos)
	return fmt.Sprintf("%s:%d", p.Filename, p.Offset)
}

// receiverName is the receiver's base type as written: `(s *Stack[T])` → Stack.
func receiverName(decl *ast.FuncDecl) string {
	if decl.Recv == nil || len(decl.Recv.List) == 0 {
		return ""
	}
	t := decl.Recv.List[0].Type
	for {
		switch x := t.(type) {
		case *ast.StarExpr:
			t = x.X
			continue
		case *ast.ParenExpr:
			t = x.X
			continue
		case *ast.IndexExpr:
			t = x.X
			continue
		case *ast.IndexListExpr:
			t = x.X
			continue
		case *ast.Ident:
			return x.Name
		}
		return ""
	}
}

func (r *recorder) refOf(path string, decl *ast.FuncDecl) *fnRef {
	return &fnRef{File: r.rel(path), Recv: receiverName(decl), Name: decl.Name.Name}
}

func (r *recorder) index(path string, file *ast.File) {
	if r.indexed[path] {
		return
	}
	r.indexed[path] = true
	line := func(pos token.Pos) int { return r.l.fset.Position(pos).Line }
	for _, d := range file.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok {
			ref := r.refOf(path, fd)
			r.decls[declKey(r.l.fset, fd.Name.Pos())] = ref
			r.symbols = append(r.symbols, symbol{
				File: ref.File, Kind: "function", Recv: ref.Recv, Name: ref.Name,
				Line: line(fd.Pos()), EndLine: line(fd.End() - 1),
			})
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.TypeSpec)
		if !ok || spec.Assign.IsValid() {
			return true
		}
		kind := "type"
		switch spec.Type.(type) {
		case *ast.StructType:
			kind = "struct"
		case *ast.InterfaceType:
			kind = "interface"
		}
		r.symbols = append(r.symbols, symbol{
			File: r.rel(path), Kind: kind, Name: spec.Name.Name,
			Line: line(spec.Pos()), EndLine: line(spec.End() - 1),
		})
		return true
	})
}

func (r *recorder) sortedSymbols() []symbol {
	out := append([]symbol{}, r.symbols...)
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Name < b.Name
	})
	return out
}

func (r *recorder) function(fn *types.Func) answer {
	fn = fn.Origin()
	sig := fn.Type().(*types.Signature)
	if recv := sig.Recv(); recv != nil && types.IsInterface(recv.Type()) {
		return answer{K: "interface", Origin: r.origin(fn.Pos()), Detail: fn.FullName()}
	}
	origin := r.origin(fn.Pos())
	if origin != "project" {
		return answer{K: "external", Origin: origin, Detail: fn.FullName()}
	}
	ref := r.decls[declKey(r.l.fset, fn.Pos())]
	if ref == nil {
		fatal("no declaration recorded for %s", fn.FullName())
	}
	return answer{K: "func", Target: ref}
}

func (r *recorder) object(obj types.Object, what string) answer {
	switch o := obj.(type) {
	case *types.Func:
		return r.function(o)
	case *types.Var:
		kind := "variable"
		if o.IsField() {
			kind = "field"
		}
		return answer{K: "func-value", Origin: r.origin(o.Pos()), Detail: kind}
	case *types.Builtin:
		return answer{K: "builtin"}
	}
	fatal("unclassified callee %s (%T)", what, obj)
	return answer{}
}

func (r *recorder) conversion(t types.Type) answer {
	switch x := types.Unalias(t).(type) {
	case *types.Named:
		return answer{K: "conversion", Origin: r.origin(x.Obj().Pos())}
	case *types.Basic:
		return answer{K: "conversion", Origin: "universe"}
	case *types.TypeParam:
		return answer{K: "conversion", Origin: "type-parameter"}
	}
	return answer{K: "conversion", Origin: "literal"}
}

func (r *recorder) classify(info *types.Info, fun ast.Expr) answer {
	fun = ast.Unparen(fun)
	if tv, ok := info.Types[fun]; ok {
		if tv.IsType() {
			return r.conversion(tv.Type)
		}
		if tv.IsBuiltin() {
			return answer{K: "builtin"}
		}
	}
	text := r.text(fun)
	switch f := fun.(type) {
	case *ast.Ident:
		return r.object(info.Uses[f], text)
	case *ast.SelectorExpr:
		if sel, ok := info.Selections[f]; ok {
			return r.object(sel.Obj(), text)
		}
		// A qualified identifier: `pkg.Name`.
		return r.object(info.Uses[f.Sel], text)
	case *ast.IndexExpr:
		if r.instantiates(info, f.X) {
			return r.classify(info, f.X)
		}
	case *ast.IndexListExpr:
		if r.instantiates(info, f.X) {
			return r.classify(info, f.X)
		}
	}
	// A call result, an indexed element, a func literal: a value.
	return answer{K: "func-value", Origin: "expression"}
}

// instantiates reports whether x names a generic function being given its
// type arguments (`Make[int]`), as opposed to a value being indexed.
func (r *recorder) instantiates(info *types.Info, x ast.Expr) bool {
	switch id := ast.Unparen(x).(type) {
	case *ast.Ident:
		_, ok := info.Instances[id]
		return ok
	case *ast.SelectorExpr:
		_, ok := info.Instances[id.Sel]
		return ok
	}
	return false
}

func (r *recorder) text(e ast.Expr) string {
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, r.l.fset, e); err != nil {
		fatal("print: %v", err)
	}
	s := strings.Join(strings.Fields(buf.String()), " ")
	if len(s) > 80 {
		s = s[:77] + "..."
	}
	return s
}

// record stores the call sites of one checked file for one platform.
func (r *recorder) record(goos, path string, info *types.Info) {
	if !r.inRoot(path) {
		return
	}
	file := r.l.parse(path)
	var stack []ast.Node
	ast.Inspect(file, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return true
		}
		stack = append(stack, n)
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		// The LINE is where the call expression starts (a chain starts at its
		// first operand), which is the line the walker records. The column is
		// the called name's, and the key the opening parenthesis: both calls
		// of `a.B().C()` start at the same offset.
		pos := r.l.fset.Position(call.Pos())
		s := &site{
			File:   r.rel(path),
			Line:   pos.Line,
			Col:    r.l.fset.Position(call.Lparen).Column,
			Callee: r.text(call.Fun),
			Form:   "other",
			Answer: r.classify(info, call.Fun),
		}
		named := call.Fun
		// An INDEXED name is still called by name: `Make[int]()` is a generic
		// function given its type argument, `handlers[i]()` an element of a
		// slice of functions. The walker records both under the indexed name
		// (the grammar cannot tell them apart) and the answer says which.
		switch f := named.(type) {
		case *ast.IndexExpr:
			named = f.X
		case *ast.IndexListExpr:
			named = f.X
		}
		switch f := named.(type) {
		case *ast.Ident:
			s.Form, s.Name = "ident", f.Name
			s.Col = r.l.fset.Position(f.Pos()).Column
		case *ast.SelectorExpr:
			s.Form, s.Name = "selector", f.Sel.Name
			s.Col = r.l.fset.Position(f.Sel.Pos()).Column
		}
		for i := len(stack) - 1; i >= 0; i-- {
			if fd, ok := stack[i].(*ast.FuncDecl); ok {
				s.From = r.refOf(path, fd)
				break
			}
		}
		key := fmt.Sprintf("%s:%d", path, r.l.fset.Position(call.Lparen).Offset)
		if r.sites[key] == nil {
			r.sites[key] = map[string]*site{}
		}
		r.sites[key][goos] = s
		return true
	})
}

func abs(fixture string, rels []string) string {
	out := make([]string, 0, len(rels))
	for _, rel := range rels {
		out = append(out, filepath.Join(fixture, filepath.FromSlash(rel)))
	}
	return strings.Join(out, string(os.PathListSeparator))
}

// moduleDirs lists every directory under root that holds a go.mod.
func moduleDirs(root string) []string {
	var dirs []string
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && d.Name() == "go.mod" {
			dirs = append(dirs, filepath.Dir(path))
		}
		return nil
	})
	if err != nil {
		fatal("walk %s: %v", root, err)
	}
	sort.Strings(dirs)
	return dirs
}

func (r *recorder) loadUnit(dir string, env []string) {
	type ignoredGroup struct {
		u     *universe
		dir   string
		files []string
	}
	groups := map[string]*ignoredGroup{}
	for _, p := range platforms {
		goos := p[0]
		full := append([]string{"GOOS=" + goos, "GOARCH=" + p[1], "CGO_ENABLED=0", "GOWORK=off", "GOPROXY=off", "GOTOOLCHAIN=local", "GOFLAGS="}, env...)
		u := &universe{l: r.l, goos: goos, pkgs: map[string]*listPkg{}, plain: map[string]*types.Package{}}
		list := goList(dir, full)
		for _, lp := range list {
			u.pkgs[lp.ImportPath] = lp
		}
		for _, lp := range list {
			if lp.Standard || !r.inRoot(lp.Dir) {
				continue
			}
			for _, group := range [][]string{lp.GoFiles, lp.TestGoFiles, lp.XTestGoFiles, lp.IgnoredGoFiles} {
				for _, n := range group {
					if strings.HasSuffix(n, ".go") {
						r.index(filepath.Join(lp.Dir, n), r.l.parse(filepath.Join(lp.Dir, n)))
					}
				}
			}
		}
		for _, lp := range list {
			if lp.Standard || !r.inRoot(lp.Dir) {
				continue
			}
			for _, n := range lp.IgnoredGoFiles {
				if !strings.HasSuffix(n, ".go") {
					continue
				}
				path := filepath.Join(lp.Dir, n)
				clause := r.l.parse(path).Name.Name
				r.ignored[path] = clause
				key := lp.Dir + "\x00" + clause
				g := groups[key]
				if g == nil {
					g = &ignoredGroup{u: u, dir: lp.Dir}
					groups[key] = g
				}
				if g.u == u {
					g.files = append(g.files, n)
				}
			}
			// The package itself.
			if _, err := u.Import(lp.ImportPath); err != nil {
				fatal("import %s: %v", lp.ImportPath, err)
			}
			_, info := u.check(lp.ImportPath, lp.Dir, lp.GoFiles)
			for _, n := range lp.GoFiles {
				r.compiled[filepath.Join(lp.Dir, n)] = true
				r.record(goos, filepath.Join(lp.Dir, n), info)
			}
			// The package with its _test.go files.
			var testPkg *types.Package
			if len(lp.TestGoFiles) > 0 {
				var testInfo *types.Info
				testPkg, testInfo = u.check(lp.ImportPath, lp.Dir, append(append([]string{}, lp.GoFiles...), lp.TestGoFiles...))
				for _, n := range lp.TestGoFiles {
					r.compiled[filepath.Join(lp.Dir, n)] = true
					r.record(goos, filepath.Join(lp.Dir, n), testInfo)
				}
			}
			// Its external test package, built against the test variant.
			if len(lp.XTestGoFiles) > 0 {
				if testPkg != nil {
					u.override = map[string]*types.Package{lp.ImportPath: testPkg}
				}
				_, xInfo := u.check(lp.ImportPath+"_test", lp.Dir, lp.XTestGoFiles)
				u.override = nil
				for _, n := range lp.XTestGoFiles {
					r.compiled[filepath.Join(lp.Dir, n)] = true
					r.record(goos, filepath.Join(lp.Dir, n), xInfo)
				}
			}
		}
	}
	// Files no platform builds: `//go:build ignore`. Each directory's set is
	// the program `go run` builds from them.
	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		g := groups[k]
		var names []string
		for _, n := range g.files {
			if !r.compiled[filepath.Join(g.dir, n)] {
				names = append(names, n)
			}
		}
		if len(names) == 0 {
			continue
		}
		_, info := g.u.check("command-line-arguments", g.dir, names)
		for _, n := range names {
			// Recorded under every platform: no constraint but `ignore` applies.
			for _, p := range platforms {
				r.record(p[0], filepath.Join(g.dir, n), info)
			}
		}
	}
}

func sameAnswer(a, b answer) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func (r *recorder) merged() []site {
	var out []site
	for _, byOS := range r.sites {
		var first *site
		same := true
		var per []perOS
		var only []string
		for _, p := range platforms {
			s := byOS[p[0]]
			if s == nil {
				continue
			}
			only = append(only, p[0])
			per = append(per, perOS{OS: p[0], Answer: s.Answer})
			if first == nil {
				first = s
			} else if !sameAnswer(first.Answer, s.Answer) {
				same = false
			}
		}
		s := *first
		if !same {
			s.Answer = answer{K: "build-dependent", Per: per}
		}
		if len(only) < len(platforms) {
			s.Only = only
		}
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.File != b.File {
			return a.File < b.File
		}
		if a.Line != b.Line {
			return a.Line < b.Line
		}
		return a.Col < b.Col
	})
	return out
}

func main() {
	if len(os.Args) != 2 {
		fatal("usage: go run main.go <fixture directory>")
	}
	fixture, err := filepath.Abs(os.Args[1])
	if err != nil {
		fatal("%v", err)
	}
	if resolved, err := filepath.EvalSymlinks(fixture); err == nil {
		fixture = resolved
	}
	raw, err := os.ReadFile(filepath.Join(fixture, "trees.json"))
	if err != nil {
		fatal("%v", err)
	}
	var cfg struct {
		Trees []treeConfig `json:"trees"`
	}
	if err := json.Unmarshal(raw, &cfg); err != nil {
		fatal("trees.json: %v", err)
	}
	fset := token.NewFileSet()
	goroot := runtime.GOROOT()
	if resolved, err := filepath.EvalSymlinks(goroot); err == nil {
		goroot = resolved
	}
	l := &loader{
		fset:   fset,
		parsed: map[string]*ast.File{},
		std:    importer.ForCompiler(fset, "source", nil),
		goroot: goroot,
	}
	snap := snapshot{GoVersion: runtime.Version()}
	for _, p := range platforms {
		snap.Platforms = append(snap.Platforms, p[0]+"/"+p[1])
	}
	for _, tree := range cfg.Trees {
		root := filepath.Join(fixture, filepath.FromSlash(tree.Root))
		r := &recorder{
			l:        l,
			fixture:  fixture,
			root:     root,
			decls:    map[string]*fnRef{},
			sites:    map[string]map[string]*site{},
			compiled: map[string]bool{},
			ignored:  map[string]string{},
			indexed:  map[string]bool{},
		}
		switch tree.Mode {
		case "modules":
			for _, dir := range moduleDirs(root) {
				r.loadUnit(dir, []string{"GO111MODULE=on"})
			}
		case "gopath":
			r.loadUnit(root, []string{"GO111MODULE=off", "GOPATH=" + abs(fixture, tree.Gopath)})
		default:
			fatal("tree %s: unknown mode %q", tree.Name, tree.Mode)
		}
		snap.Trees = append(snap.Trees, treeOut{
			Name: tree.Name, Root: tree.Root, Calls: r.merged(), Symbols: r.sortedSymbols(),
		})
	}
	enc := json.NewEncoder(os.Stdout)
	if err := enc.Encode(snap); err != nil {
		fatal("%v", err)
	}
}
