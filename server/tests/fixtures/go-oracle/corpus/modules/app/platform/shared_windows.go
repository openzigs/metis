package platform

func shared() string { return "windows" }

// Conn is the Windows twin.
type Conn struct{}

// Open is declared on both twins of Conn.
func (Conn) Open() {}

// Hook is the Windows twin.
type Hook func() *Dev
