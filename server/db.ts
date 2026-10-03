import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export type QueryResult = { rows: any[]; rowCount?: number | null };
export interface Executor { query: (sql: string, params?: any[]) => Promise<QueryResult> }
export interface Database extends Executor { transaction: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T>; close: () => Promise<void>; engine: 'pglite' | 'postgres' }

// A PGlite connection is shared. Serialize the WHOLE transaction, including reads,
// so another request cannot accidentally execute inside its SQL transaction.
export async function openDatabase(options: { dataDir?: string; url?: string } = {}): Promise<Database> {
  const migrationDir = new URL('./migrations/', import.meta.url);
  const migration = (await Promise.all((await readdir(migrationDir)).filter(name => /^\d+.*\.sql$/.test(name)).sort().map(name => readFile(new URL(name, migrationDir), 'utf8')))).join('\n');
  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url, max: 10, connectionTimeoutMillis: 10000 });
    const setup = await pool.connect();
    let setupError: unknown;
    try {
      await setup.query('BEGIN');
      await setup.query('SELECT pg_advisory_xact_lock(752496123)');
      await setup.query(migration);
      await setup.query('COMMIT');
    } catch (error) { await setup.query('ROLLBACK'); setupError = error; }
    finally { setup.release(); }
    if (setupError) { await pool.end(); throw setupError; }
    return {
      engine: 'postgres',
      query: async (sql, params = []) => pool.query(sql, params),
      transaction: async (fn) => {
        const client = await pool.connect();
        try { await client.query('BEGIN'); const result = await fn({ query: (sql, params = []) => client.query(sql, params) }); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      close: () => pool.end(),
    };
  }
  const dataDir = options.dataDir === ':memory:' ? undefined : resolve(options.dataDir ?? '.local/database');
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const engine = new PGlite(dataDir);
  await engine.waitReady;
  await engine.exec(migration);
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const task = tail.then(fn, fn); tail = task.then(() => undefined, () => undefined); return task;
  };
  const executor: Executor = { query: async (sql, params = []) => engine.query(sql, params) };
  return {
    engine: 'pglite',
    query: (sql, params) => serialize(() => executor.query(sql, params)),
    transaction: (fn) => serialize(async () => {
      await engine.exec('BEGIN');
      try { const result = await fn(executor); await engine.exec('COMMIT'); return result; }
      catch (error) { await engine.exec('ROLLBACK'); throw error; }
    }),
    close: () => serialize(() => engine.close()),
  };
}
