/**
 * #1071 — what the Go type resolver knows about the standard library without
 * reading it: which import paths ARE the standard library, and which of its
 * exported types are interfaces.
 *
 * Both are positive lists on purpose. The resolver records a call as `external`
 * (decided: no project callee) only on positive evidence, so "this path is the
 * standard library" must be a fact, not a guess from the path's shape — a tree
 * without a `go.mod` can hold a project directory named `errors` or `http`.
 * And a method called on a value of a standard-library INTERFACE type
 * (`http.Handler`, `io.Writer`) is dispatched at run time to whatever
 * implements it, very often a project type, so that call is `interface`
 * (undecided), never `external`.
 *
 * Maintenance: a package or interface missing here costs precision, never
 * correctness — an unlisted path is treated like any third-party one, and an
 * unlisted interface type like a concrete external type.
 */

/** Standard-library import paths (Go 1.24), plus the cgo pseudo-package. */
export const GO_STDLIB_PACKAGES: ReadonlySet<string> = new Set(
  (
    "C archive/tar archive/zip bufio bytes cmp compress/bzip2 compress/flate compress/gzip " +
    "compress/lzw compress/zlib container/heap container/list container/ring context crypto " +
    "crypto/aes crypto/cipher crypto/des crypto/dsa crypto/ecdh crypto/ecdsa crypto/ed25519 " +
    "crypto/elliptic crypto/fips140 crypto/hkdf crypto/hmac crypto/md5 crypto/mlkem " +
    "crypto/pbkdf2 crypto/rand crypto/rc4 crypto/rsa crypto/sha1 crypto/sha256 crypto/sha3 " +
    "crypto/sha512 crypto/subtle crypto/tls crypto/x509 crypto/x509/pkix database/sql " +
    "database/sql/driver debug/buildinfo debug/dwarf debug/elf debug/gosym debug/macho " +
    "debug/pe debug/plan9obj embed encoding encoding/ascii85 encoding/asn1 encoding/base32 " +
    "encoding/base64 encoding/binary encoding/csv encoding/gob encoding/hex encoding/json " +
    "encoding/pem encoding/xml errors expvar flag fmt go/ast go/build go/build/constraint " +
    "go/constant go/doc go/doc/comment go/format go/importer go/parser go/printer go/scanner " +
    "go/token go/types go/version hash hash/adler32 hash/crc32 hash/crc64 hash/fnv " +
    "hash/maphash html html/template image image/color image/color/palette image/draw " +
    "image/gif image/jpeg image/png index/suffixarray io io/fs io/ioutil iter log log/slog " +
    "log/syslog maps math math/big math/bits math/cmplx math/rand math/rand/v2 mime " +
    "mime/multipart mime/quotedprintable net net/http net/http/cgi net/http/cookiejar " +
    "net/http/fcgi net/http/httptest net/http/httptrace net/http/httputil net/http/pprof " +
    "net/mail net/netip net/rpc net/rpc/jsonrpc net/smtp net/textproto net/url os os/exec " +
    "os/signal os/user path path/filepath plugin reflect regexp regexp/syntax runtime " +
    "runtime/cgo runtime/coverage runtime/debug runtime/metrics runtime/pprof runtime/race " +
    "runtime/trace slices sort strconv strings structs sync sync/atomic syscall syscall/js " +
    "testing testing/fstest testing/iotest testing/quick testing/slogtest testing/synctest " +
    "text/scanner text/tabwriter text/template text/template/parse time time/tzdata unicode " +
    "unicode/utf16 unicode/utf8 unique unsafe weak"
  ).split(" "),
);

/**
 * Standard-library interface types project code commonly implements or is
 * handed, by import path. A method called through one is `interface`.
 */
const STDLIB_INTERFACES: Readonly<Record<string, string>> = {
  io:
    "Reader Writer Closer Seeker ReadWriter ReadCloser WriteCloser ReadWriteCloser ReadSeeker " +
    "ReadSeekCloser WriteSeeker ReadWriteSeeker ReaderFrom WriterTo ReaderAt WriterAt " +
    "ByteReader ByteScanner ByteWriter RuneReader RuneScanner StringWriter",
  "io/fs": "FS File DirEntry FileInfo ReadDirFS ReadFileFS StatFS SubFS GlobFS ReadDirFile",
  os: "FileInfo DirEntry Signal",
  fmt: "Stringer GoStringer Formatter Scanner State ScanState",
  sort: "Interface",
  "container/heap": "Interface",
  context: "Context",
  "net/http":
    "Handler ResponseWriter RoundTripper Flusher Hijacker Pusher FileSystem File CookieJar",
  net: "Conn Listener Addr PacketConn Error",
  "database/sql": "Scanner Result",
  "database/sql/driver":
    "Valuer Driver Conn Stmt Rows Tx Result Connector Execer ExecerContext Queryer " +
    "QueryerContext Pinger ConnBeginTx ConnPrepareContext",
  encoding: "TextMarshaler TextUnmarshaler BinaryMarshaler BinaryUnmarshaler",
  "encoding/json": "Marshaler Unmarshaler",
  "encoding/xml": "Marshaler Unmarshaler MarshalerAttr UnmarshalerAttr TokenReader",
  flag: "Value Getter",
  hash: "Hash Hash32 Hash64",
  "log/slog": "Handler LogValuer Leveler",
  crypto: "Signer Decrypter",
  testing: "TB",
  image: "Image PalettedImage",
  "image/color": "Color Model",
  "image/draw": "Image Drawer Quantizer",
  sync: "Locker",
  "mime/multipart": "File",
};

const STDLIB_INTERFACE_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(STDLIB_INTERFACES).map(([path, names]) => [path, new Set(names.split(" "))]),
);

/** True when `importPath.typeName` is a standard-library interface type this module lists. */
export function isGoStdlibInterface(importPath: string, typeName: string): boolean {
  return STDLIB_INTERFACE_SETS.get(importPath)?.has(typeName) ?? false;
}
