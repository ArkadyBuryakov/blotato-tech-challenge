import { CompiledQuery, Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import type { Db as BossDb } from "pg-boss";
import type { Database } from "./schema";

// Return int8 (bigserial ids, counts) as numbers; values stay well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));

export type DB = Kysely<Database>;
export type Tx = Transaction<Database>;

const needsSsl = (url: string) => !/@(localhost|127\.0\.0\.1|postgres)(:|\/)/.test(url);

export const createPool = (url: string, max = 10) =>
  new pg.Pool({
    connectionString: url,
    max,
    // Heroku Postgres requires TLS with a certificate that is not in the default chain.
    ssl: needsSsl(url) ? { rejectUnauthorized: false } : undefined,
  });

export const createDb = (pool: pg.Pool): DB => new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

/** Lets pg-boss enqueue jobs inside our transaction (transactional outbox). */
export const bossDb = (trx: Tx | DB): BossDb => ({
  executeSql: async (text, values) => {
    const res = await trx.executeQuery(CompiledQuery.raw(text, (values ?? []) as unknown[]));
    return { rows: res.rows as unknown[] as never[] };
  },
});
