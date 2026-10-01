/**
 * #622 — an in-process stand-in for Postgres `LISTEN` / `pg_notify`, shaped as
 * the slice of `pg.Pool` that `@socket.io/postgres-adapter` uses: `connect()`
 * hands out a listening client, `query("SELECT pg_notify($1, $2)")` delivers the
 * payload to every client LISTENing on that channel, and every other statement
 * (the attachments table DDL and cleanup) is recorded and answered empty.
 *
 * One bus with one pool per replica stands for one shared database, so the real
 * adapter and real Socket.IO servers can be driven across "replicas" in the
 * default unit suite, without a live Postgres. The real-Postgres proof of the
 * same scenarios is `socket-cluster-adapter-postgres.integration.test.ts`.
 */
import { EventEmitter } from "node:events";
import type { Pool } from "pg";

class FakeListenClient extends EventEmitter {
  readonly channels = new Set<string>();
  released = false;

  constructor(private readonly bus: FakePgNotifyBus) {
    super();
  }

  async query(sql: string): Promise<{ rows: never[] }> {
    const listen = /^LISTEN "(.+)"$/.exec(sql.trim());
    if (listen) this.channels.add(listen[1]);
    return { rows: [] };
  }

  release(): void {
    this.released = true;
    this.bus.clients.delete(this);
  }
}

export class FakePgNotifyBus {
  readonly clients = new Set<FakeListenClient>();
  /** Every non-notify statement any pool ran, in order. */
  readonly statements: string[] = [];

  /** A pool for one replica. `ended` flips when the adapter's owner ends it. */
  pool(): Pool & { ended: boolean } {
    const emitter = new EventEmitter();
    const pool = Object.assign(emitter, {
      ended: false,
      connect: async () => {
        const client = new FakeListenClient(this);
        this.clients.add(client);
        return client;
      },
      query: async (sql: string, params: unknown[] = []) => {
        if (sql.includes("pg_notify")) {
          const [channel, payload] = params as [string, string];
          // Postgres delivers NOTIFY asynchronously, after the statement returns.
          setImmediate(() => {
            for (const client of this.clients) {
              if (client.channels.has(channel)) {
                client.emit("notification", { channel, payload });
              }
            }
          });
          return { rows: [] };
        }
        this.statements.push(sql);
        return { rows: [] };
      },
      end: async () => {
        pool.ended = true;
      },
    });
    return pool as unknown as Pool & { ended: boolean };
  }
}
