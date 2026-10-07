/**
 * LDAPAuthProvider against the REAL `ldapts` client (no `vi.mock("ldapts")`).
 *
 * Every other LDAP test mocks `ldapts`, so a major bump of the library (PR #667,
 * 8.1.8 → 9.2.0) could break the wire protocol, the error mapping or the TLS
 * option pass-through and still leave them green. This file runs the provider's
 * real `Client` against a minimal in-process LDAPv3 responder (BER over a local
 * socket) and pins the three security-relevant behaviours:
 *
 *   1. a wrong user password (resultCode 49) is an auth *failure* — the route
 *      maps that to 401 — not a 5xx "service error";
 *   2. user input reaches the directory as a literal equality value, never as
 *      filter syntax (OWASP A03, LDAP injection);
 *   3. `ldaps://` still verifies the server certificate unless the non-production
 *      `tlsSkipVerify` escape hatch is set.
 */
import net from "node:net";
import tls from "node:tls";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client, InvalidCredentialsError } from "ldapts";

import {
  LDAPAuthProvider,
  clearLDAPConfig,
  setLDAPConfig,
  type LDAPConfig,
} from "../src/lib/auth/ldap-provider.js";
import {
  getTestSigningKey,
  type TestSigningKey,
} from "../src/lib/auth/__tests__/saml-test-helpers.js";

// ── Minimal BER ──────────────────────────────────────────────────────────────

interface TLV {
  tag: number;
  value: Buffer;
  end: number;
}

function readTLV(buf: Buffer, off: number): TLV | null {
  if (off + 2 > buf.length) return null;
  const tag = buf[off];
  let len = buf[off + 1];
  let p = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (p + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i];
    p += n;
  }
  if (p + len > buf.length) return null;
  return { tag, value: buf.subarray(p, p + len), end: p + len };
}

function children(buf: Buffer): TLV[] {
  const out: TLV[] = [];
  let off = 0;
  while (off < buf.length) {
    const t = readTLV(buf, off);
    if (!t) break;
    out.push(t);
    off = t.end;
  }
  return out;
}

function tlv(tag: number, value: Buffer): Buffer {
  const len = value.length;
  let header: Buffer;
  if (len < 0x80) header = Buffer.from([tag, len]);
  else if (len < 0x100) header = Buffer.from([tag, 0x81, len]);
  else header = Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
  return Buffer.concat([header, value]);
}

const octets = (s: string, tag = 0x04): Buffer => tlv(tag, Buffer.from(s, "utf8"));

function int(n: number, tag = 0x02): Buffer {
  const bytes: number[] = [];
  do {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(tag, Buffer.from(bytes));
}

function readInt(b: Buffer): number {
  let n = 0;
  for (const byte of b) n = n * 256 + byte;
  return n;
}

const message = (id: number, op: Buffer): Buffer => tlv(0x30, Buffer.concat([int(id), op]));
const ldapResult = (tag: number, code: number): Buffer =>
  tlv(tag, Buffer.concat([int(code, 0x0a), octets(""), octets("")]));

/** Decoded RFC 4511 filter, enough to tell an equality match from injected syntax. */
type DecodedFilter =
  | { and: DecodedFilter[] }
  | { or: DecodedFilter[] }
  | { not: DecodedFilter }
  | { eq: [string, string] }
  | { other: number };

function decodeFilter(t: TLV): DecodedFilter {
  switch (t.tag) {
    case 0xa0:
      return { and: children(t.value).map(decodeFilter) };
    case 0xa1:
      return { or: children(t.value).map(decodeFilter) };
    case 0xa2:
      return { not: decodeFilter(children(t.value)[0]) };
    case 0xa3: {
      const [attr, val] = children(t.value);
      return { eq: [attr.value.toString("utf8"), val.value.toString("utf8")] };
    }
    default:
      // 0xa4 substrings, 0x87 present, … — anything an injection would produce.
      return { other: t.tag };
  }
}

// ── In-process directory ─────────────────────────────────────────────────────

const SERVICE_DN = "cn=svc,dc=example,dc=com";
const SERVICE_PW = "svc-secret";
const USER_DN = "cn=Alice,ou=People,dc=example,dc=com";
const USER_PW = "correct-horse";

interface Directory {
  url: string;
  binds: string[];
  filters: DecodedFilter[];
  close: () => Promise<void>;
}

function handle(socket: net.Socket, dir: Pick<Directory, "binds" | "filters">): void {
  let pending = Buffer.alloc(0);
  socket.on("error", () => {
    /* client-side TLS rejection resets the socket — expected in one test */
  });
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const msg = readTLV(pending, 0);
      if (!msg) return;
      pending = pending.subarray(msg.end);
      const [idTlv, op] = children(msg.value);
      const id = readInt(idTlv.value);

      if (op.tag === 0x60) {
        // BindRequest: version, name, [0] simple password
        const [, name, pw] = children(op.value);
        const dn = name.value.toString("utf8");
        const password = pw.value.toString("utf8");
        dir.binds.push(dn);
        const ok =
          (dn === SERVICE_DN && password === SERVICE_PW) ||
          (dn === USER_DN && password === USER_PW);
        socket.write(message(id, ldapResult(0x61, ok ? 0 : 49)));
      } else if (op.tag === 0x63) {
        // SearchRequest: base, scope, deref, size, time, typesOnly, filter, attrs
        const parts = children(op.value);
        dir.filters.push(decodeFilter(parts[6]));
        const attr = (type: string, ...vals: string[]): Buffer =>
          tlv(
            0x30,
            Buffer.concat([octets(type), tlv(0x31, Buffer.concat(vals.map((v) => octets(v))))]),
          );
        const entry = tlv(
          0x64,
          Buffer.concat([
            octets(USER_DN),
            tlv(
              0x30,
              Buffer.concat([
                attr("sAMAccountName", "alice"),
                attr("displayName", "Alice Example"),
                attr("mail", "alice@example.com"),
                attr("memberOf", "CN=Admins,OU=Groups,DC=example,DC=com"),
              ]),
            ),
          ]),
        );
        socket.write(message(id, entry));
        socket.write(message(id, ldapResult(0x65, 0)));
      } else if (op.tag === 0x42) {
        socket.end();
      }
    }
  });
}

async function startDirectory(secure?: TestSigningKey): Promise<Directory> {
  const dir = { binds: [] as string[], filters: [] as DecodedFilter[] };
  const server = secure
    ? tls.createServer({ key: secure.privateKey, cert: secure.certificatePem }, (s) =>
        handle(s, dir),
      )
    : net.createServer((s) => handle(s, dir));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...dir,
    url: `${secure ? "ldaps" : "ldap"}://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function configFor(url: string, overrides: Partial<LDAPConfig> = {}): LDAPConfig {
  return {
    url,
    baseDN: "dc=example,dc=com",
    bindDN: SERVICE_DN,
    bindPassword: SERVICE_PW,
    userSearchBase: "ou=People,dc=example,dc=com",
    searchFilter: "(&(objectClass=user)(sAMAccountName={{username}}))",
    groupMappings: [{ claimValue: "Admins", role: "admin" }],
    defaultRole: "reader",
    tlsSkipVerify: false,
    connectionTimeout: 5000,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

let directory: Directory | undefined;

afterEach(async () => {
  clearLDAPConfig();
  await directory?.close();
  directory = undefined;
});

describe("LDAPAuthProvider with the real ldapts client", () => {
  it("the real client still surfaces resultCode 49 as InvalidCredentialsError", async () => {
    directory = await startDirectory();
    const client = new Client({ url: directory.url, connectTimeout: 5000 });
    try {
      await expect(client.bind(USER_DN, "wrong")).rejects.toBeInstanceOf(InvalidCredentialsError);
    } finally {
      await client.unbind().catch(() => undefined);
    }
  });

  it("a wrong user password is an auth failure (→ 401), not a service error", async () => {
    directory = await startDirectory();
    setLDAPConfig(configFor(directory.url));

    const result = await new LDAPAuthProvider().authenticate("alice", "wrong");

    expect(result).toEqual({ success: false, error: "Invalid username or password" });
    expect(directory.binds).toEqual([SERVICE_DN, USER_DN]);
  });

  it("the correct password authenticates and maps attributes and groups", async () => {
    directory = await startDirectory();
    setLDAPConfig(configFor(directory.url));

    const result = await new LDAPAuthProvider().authenticate("alice", USER_PW);

    expect(result).toEqual({
      success: true,
      user: {
        username: "alice",
        displayName: "Alice Example",
        email: "alice@example.com",
        role: "admin",
        groups: ["Admins"],
      },
    });
  });

  it("filter metacharacters in the username reach the directory as a literal equality value", async () => {
    directory = await startDirectory();
    setLDAPConfig(configFor(directory.url));
    const payload = "*)(objectClass=*";

    await new LDAPAuthProvider().authenticate(payload, "irrelevant");

    expect(directory.filters).toEqual([
      { and: [{ eq: ["objectClass", "user"] }, { eq: ["sAMAccountName", payload] }] },
    ]);
  });

  describe("ldaps:// certificate verification", () => {
    let key: TestSigningKey;
    beforeAll(() => {
      key = getTestSigningKey();
    });

    it("rejects a self-signed directory certificate by default — no bind is sent", async () => {
      directory = await startDirectory(key);
      setLDAPConfig(configFor(directory.url));

      const result = await new LDAPAuthProvider().authenticate("alice", USER_PW);

      expect(result.success).toBe(false);
      expect(directory.binds).toEqual([]);
    });

    it("accepts it only through the explicit non-production tlsSkipVerify escape hatch", async () => {
      directory = await startDirectory(key);
      setLDAPConfig(configFor(directory.url, { tlsSkipVerify: true }));

      const result = await new LDAPAuthProvider().authenticate("alice", USER_PW);

      expect(result.success).toBe(true);
    });
  });
});
