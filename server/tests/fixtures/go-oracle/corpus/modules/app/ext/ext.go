// Package ext: receivers declared OUTSIDE the project — the standard library
// and a dependency — as values, interfaces, structs embedding interfaces, and
// their members and results.
package ext

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"debug/elf"
	"errors"
	"flag"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"example.net/acme/queue"
)

// sink is a project type that implements the dependency's interface, the
// standard library's io.Writer, io.ReaderAt and http.Handler.
type sink struct{}

func (sink) Consume(msg string) error                         { return nil }
func (sink) Close() error                                     { return nil }
func (sink) Write(p []byte) (int, error)                      { return len(p), nil }
func (sink) ReadAt(p []byte, off int64) (int, error)          { return 0, nil }
func (sink) ServeHTTP(w http.ResponseWriter, r *http.Request) {}
func (sink) Done() <-chan struct{}                            { return nil }

func handler(w http.ResponseWriter, r *http.Request) {}

func stdlibValues(r *http.Request, w http.ResponseWriter, resp *http.Response) {
	r.Context().Done()
	w.Header().Set("a", "b")
	resp.Body.Close()
	w.WriteHeader(200)
	r.URL.Query().Get("q")
	var buf bytes.Buffer
	buf.WriteString("x")
	strings.NewReader("x").Len()
	var mu sync.Mutex
	mu.Lock()
	mu.Unlock()
	var srv http.Server
	srv.Handler.ServeHTTP(w, r)
	srv.Close()
}

func stdlibPackage(w http.ResponseWriter, r *http.Request) {
	http.HandleFunc("/", handler)
	http.HandlerFunc(handler).ServeHTTP(w, r)
	io.Discard.Write(nil)
	os.Stdout.Write(nil)
	flag.Usage()
	_ = errors.New("x").Error()
	_ = time.Duration(5).String()
	time.Now().Unix()
	_ = context.Background().Err()
	io.WriteString(sink{}, "x")
}

func stdlibEmbedsInterface(sec *elf.Section) {
	sec.ReadAt(nil, 0)
	sec.Open().Seek(0, 0)
}

func stdlibChains(priv *ecdsa.PrivateKey, r *http.Request) {
	x, _ := priv.Add(nil, nil, nil, nil)
	_ = x.Sign()
	resp, _ := http.DefaultTransport.RoundTrip(r)
	resp.Body.Close()
}

func universe(err error, v any) {
	_ = err.Error()
	_ = len("x")
	_ = string(rune(65))
	_ = append([]int{}, 1)
	panic(v)
}

func thirdParty(c *queue.Client, q queue.Consumer, w queue.Wrapped) {
	c.Publish("x")
	q.Consume("x")
	w.Consume("y")
	w.Close()
	c.Sink.Close()
	c.Hook()
	c.Stats().Reset()
	c.Consumer().Consume("z")
}

func thirdPartyPackage() {
	queue.NewClient().Publish("y")
	queue.OnError(nil)
	queue.Default.Publish("z")
	cl, err := queue.Dial("addr")
	_ = err
	cl.Publish("w")
	_ = queue.Map([]int{1}, func(i int) int { return i })
	box := queue.Box[*sink]{}
	box.Get().Close()
	_ = queue.Handler(func(string) error { return nil })
}

func thirdPartyElements(c *queue.Client, b queue.Batch, hd queue.Handler) {
	c.Peers[0].Publish("p")
	b[0].Publish("b")
	_ = hd("x").Error()
	_ = queue.Handlers[0]("x")
	for _, peer := range c.Peers {
		peer.Stats().Reset()
	}
}

// Wrapper embeds the dependency's interface.
type Wrapper struct{ queue.Consumer }

// Buffered embeds a standard-library struct.
type Buffered struct{ bytes.Buffer }

// Served embeds a standard-library interface beside a project struct.
type Served struct {
	http.Handler
	sink
}

// MyClient is a defined type over the dependency's struct: it keeps the fields.
type MyClient queue.Client

// Extra is MyClient's own method.
func (MyClient) Extra() {}

// MyBuffer is a defined type over a standard-library struct.
type MyBuffer bytes.Buffer

// Holder holds external values in fields.
type Holder struct {
	Client *queue.Client
	Out    io.Writer
	Mu     sync.Mutex
	Sink   sink
}

func projectOverExternal(wr Wrapper, b Buffered, sv Served, mc MyClient, mb MyBuffer, h *Holder) {
	wr.Consume("x")
	b.WriteString("x")
	b.Len()
	sv.Write(nil)
	sv.Consume("y")
	mc.Sink.Close()
	mc.Extra()
	mc.Hook()
	_ = mb
	h.Client.Publish("x")
	h.Out.Write(nil)
	h.Mu.Lock()
	h.Sink.Close()
}
