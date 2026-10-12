// Package queue stands for a DEPENDENCY: it lives outside every tree METIS is
// given, so the resolver never reads it. The corpus calls into it to pin what
// the resolver says about values of types it cannot examine.
package queue

// Consumer is an interface a project type can implement.
type Consumer interface {
	Consume(msg string) error
	Close() error
}

// Stats is a concrete type returned by a method.
type Stats struct{ Sent int }

// Reset is a concrete method.
func (s *Stats) Reset() {}

// Client is a concrete type with an interface field and a func field.
type Client struct {
	Name  string
	Sink  Consumer
	Hook  func() error
	Peers []*Client
}

// Batch is a named slice of clients.
type Batch []*Client

// NewClient returns a concrete value.
func NewClient() *Client { return &Client{} }

// Dial returns a concrete value and an error.
func Dial(addr string) (*Client, error) { return &Client{Name: addr}, nil }

// Publish is a concrete method.
func (c *Client) Publish(msg string) error { return nil }

// Consumer returns an interface value.
func (c *Client) Consumer() Consumer { return c.Sink }

// Stats returns a concrete value.
func (c *Client) Stats() *Stats { return &Stats{} }

// Wrapped embeds an interface: its Consume and Close are promoted from it.
type Wrapped struct {
	Consumer
	Label string
}

// Handler is a func type.
type Handler func(msg string) error

// OnError is a package-level func VARIABLE, which a caller cannot tell from a
// function by its spelling.
var OnError = func(err error) {}

// Default is a package-level variable of a concrete type.
var Default = NewClient()

// Map is a generic function.
func Map[T any](in []T, f func(T) T) []T {
	out := make([]T, 0, len(in))
	for _, v := range in {
		out = append(out, f(v))
	}
	return out
}

// Box is a generic type.
type Box[T any] struct{ V T }

// Get returns the boxed value.
func (b Box[T]) Get() T { return b.V }
