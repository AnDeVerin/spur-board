import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tables } from '../../src/index.ts';
import { migrate, migrationsDir, readMigrations, type Migration } from '../../src/store/migrate.ts';
import { openDatabase, openStore } from '../../src/store/store.ts';
import { insertSampleRows, sampleRows, tableNames } from './sample-rows.ts';

const INDEXES: Record<string, { table: string; columns: string[]; partialUnique: boolean }> = {
  link_pr_pair: { table: 'link', columns: ['task_id', 'repo', 'number'], partialUnique: true },
  link_session_pair: { table: 'link', columns: ['task_id', 'session_id'], partialUnique: true },
  link_one_active_pr: { table: 'link', columns: ['task_id'], partialUnique: true },
  submission_task_column_submitted: {
    table: 'submission',
    columns: ['task_id', 'column', 'submitted_at'],
    partialUnique: false,
  },
  block_task_state: { table: 'block', columns: ['task_id', 'state'], partialUnique: false },
  comment_task_id: { table: 'comment', columns: ['task_id', 'id'], partialUnique: false },
  event_task_id: { table: 'event', columns: ['task_id', 'id'], partialUnique: false },
  event_at: { table: 'event', columns: ['at'], partialUnique: false },
  outbox_state_next_at: { table: 'outbox', columns: ['state', 'next_at'], partialUnique: false },
  outbox_parent_outbox_id: {
    table: 'outbox',
    columns: ['parent_outbox_id'],
    partialUnique: false,
  },
};

const real = readMigrations(migrationsDir);
// The synthetic migrations follow the real chain, so their versions move with it.
const latest = real.length;
const prefix = (version: number): string => String(version).padStart(4, '0');
const probe: Migration = {
  version: latest + 1,
  name: `${prefix(latest + 1)}_probe`,
  sql: 'ALTER TABLE task ADD COLUMN probe TEXT; CREATE TABLE probe (id INTEGER PRIMARY KEY) STRICT;',
};
const failing: Migration = {
  version: latest + 2,
  name: `${prefix(latest + 2)}_failing`,
  sql: 'CREATE TABLE half (x INTEGER) STRICT; INSERT INTO no_such_table VALUES (1);',
};

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'core-migrate-'));
}

/** A raw connection with the store PRAGMAs, plus a Kysely view of it. Closed after the test. */
function rawDb(file: string): { raw: Database.Database; db: Kysely<Tables> } {
  const raw = openDatabase(file);
  const db = new Kysely<Tables>({ dialect: new SqliteDialect({ database: raw }) });
  cleanup.push(() => db.destroy());
  return { raw, db };
}

function userVersion(raw: Database.Database): number {
  return raw.pragma('user_version', { simple: true }) as number;
}

function tables(raw: Database.Database): string[] {
  return raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*'")
    .pluck()
    .all() as string[];
}

function rows(raw: Database.Database, table: string): unknown[] {
  return raw.prepare(`SELECT * FROM "${table}"`).all();
}

function expectSampleRows(raw: Database.Database, extra: Record<string, object> = {}): void {
  for (const table of tableNames) {
    expect(rows(raw, table)).toEqual([{ ...sampleRows[table], ...extra[table] }]);
  }
}

/** Inserts `row` with raw SQL, for rows in the shape of an older schema. */
function insertRaw(raw: Database.Database, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  raw
    .prepare(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row));
}

/** `row` without the columns a later migration added. */
function without(row: object, columns: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => !columns.includes(name)));
}

function backups(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.bak'));
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('migrate', () => {
  it('creates every table and index from an empty file', () => {
    const dir = tempDir();
    const store = openStore(join(dir, 'board.db'));
    cleanup.push(() => store.close());
    const raw = new Database(join(dir, 'board.db'), { readonly: true });
    cleanup.push(() => raw.close());

    expect(tables(raw).sort()).toEqual([...tableNames].sort());
    const indexes = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT GLOB 'sqlite_autoindex_*'",
      )
      .pluck()
      .all() as string[];
    expect(indexes.sort()).toEqual(Object.keys(INDEXES).sort());
    for (const [name, spec] of Object.entries(INDEXES)) {
      const columns = raw.prepare('SELECT name FROM pragma_index_info(?)').pluck().all(name);
      expect(columns, name).toEqual(spec.columns);
      const listed = raw
        .prepare('SELECT "unique", partial FROM pragma_index_list(?) WHERE name = ?')
        .all(spec.table, name);
      const flag = spec.partialUnique ? 1 : 0;
      expect(listed, name).toEqual([{ unique: flag, partial: flag }]);
    }
    expect(raw.pragma('foreign_key_check')).toEqual([]);
    expect(userVersion(raw)).toBe(latest);
    expect(store.migration).toEqual({
      from: 0,
      to: latest,
      applied: real.map((migration) => migration.name),
      backup: null,
    });
    expect(backups(dir)).toEqual([]);
  });

  it('keeps rows written at N-1 when migrating to N', async () => {
    const dir = tempDir();
    const { raw, db } = rawDb(join(dir, 'board.db'));
    migrate(raw, real);
    await insertSampleRows(db);

    const result = migrate(raw, [...real, probe]);

    expect(result.applied).toEqual([probe.name]);
    expect(result).toMatchObject({ from: latest, to: probe.version });
    expect(userVersion(raw)).toBe(probe.version);
    expectSampleRows(raw, { task: { probe: null } });
    expect(tables(raw)).toContain('probe');
    expect(result.backup).not.toBeNull();
    expect(backups(dir)).toHaveLength(1);
    const backup = new Database(result.backup ?? '', { readonly: true });
    cleanup.push(() => backup.close());
    expect(userVersion(backup)).toBe(latest);
    expectSampleRows(backup);
  });

  it('rolls back every pending migration when one throws and keeps the backup', async () => {
    const dir = tempDir();
    const { raw, db } = rawDb(join(dir, 'board.db'));
    migrate(raw, real);
    await insertSampleRows(db);

    expect(() => migrate(raw, [...real, probe, failing])).toThrow(
      new RegExp(`${failing.name}.*v${String(latest)}`),
    );

    expect(userVersion(raw)).toBe(latest);
    expect(tables(raw)).not.toContain('probe');
    expect(tables(raw)).not.toContain('half');
    expectSampleRows(raw);
    expect(backups(dir)).toHaveLength(1);
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('applies nothing and writes no backup on a current database', async () => {
    const dir = tempDir();
    const file = join(dir, 'board.db');
    const first = openStore(file);
    await insertSampleRows(first.db);
    await first.close();
    const before = readdirSync(dir).sort();

    const second = openStore(file);
    expect(second.migration).toEqual({ from: latest, to: latest, applied: [], backup: null });
    for (const table of tableNames) {
      expect(await second.db.selectFrom(table).selectAll().execute()).toEqual([sampleRows[table]]);
    }
    await second.close();

    expect(readdirSync(dir).sort()).toEqual(before);
    expect(backups(dir)).toEqual([]);
  });

  it('keeps v1 outbox and comment rows with empty delivery columns', () => {
    const dir = tempDir();
    const { raw } = rawDb(join(dir, 'board.db'));
    const delivery = real.findIndex((migration) => migration.name === '0002_delivery');
    migrate(raw, real.slice(0, delivery));
    const comment = without(sampleRows.comment, ['delivery_state']);
    const outbox = without(sampleRows.outbox, [
      'parent_outbox_id',
      'first_attempt_at',
      'first_delivery_at',
      'attempt_started',
    ]);
    insertRaw(raw, 'task', sampleRows.task);
    insertRaw(raw, 'block', sampleRows.block);
    insertRaw(raw, 'comment', comment);
    insertRaw(raw, 'outbox', outbox);

    migrate(raw, real);

    expect(rows(raw, 'comment')).toEqual([{ ...comment, delivery_state: null }]);
    expect(rows(raw, 'outbox')).toEqual([
      {
        ...outbox,
        parent_outbox_id: null,
        first_attempt_at: null,
        first_delivery_at: null,
        attempt_started: 0,
      },
    ]);
    expect(rows(raw, 'conversation')).toEqual([]);
    expect(rows(raw, 'transport_health')).toEqual([]);
    expect(rows(raw, 'space_slot')).toEqual([]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps uncertain v2 rows without a delivery-search bound', () => {
    const dir = tempDir();
    const { raw } = rawDb(join(dir, 'board.db'));
    const search = real.findIndex((migration) => migration.name === '0003_delivery_search');
    migrate(raw, real.slice(0, search));
    const outbox = {
      ...without(sampleRows.outbox, ['first_delivery_at', 'attempt_started']),
      uncertain: 1,
    };
    insertRaw(raw, 'outbox', outbox);

    migrate(raw, real);

    expect(rows(raw, 'outbox')).toEqual([
      { ...outbox, first_delivery_at: null, attempt_started: 0 },
    ]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('marks legacy in-flight rows as started and leaves other rows unstarted', () => {
    const dir = tempDir();
    const { raw } = rawDb(join(dir, 'board.db'));
    const started = real.findIndex((migration) => migration.name === '0004_attempt_started');
    migrate(raw, real.slice(0, started));
    const legacy = without(sampleRows.outbox, ['attempt_started']);
    insertRaw(raw, 'outbox', { ...legacy, id: 1, dedupe_key: 'pending' });
    insertRaw(raw, 'outbox', {
      ...legacy,
      id: 2,
      dedupe_key: 'in-flight',
      state: 'in_flight',
      attempts: 1,
    });

    migrate(raw, real);

    expect(raw.prepare('SELECT id, attempt_started FROM outbox ORDER BY id').all()).toEqual([
      { id: 1, attempt_started: 0 },
      { id: 2, attempt_started: 1 },
    ]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('refuses a database newer than the code', () => {
    const dir = tempDir();
    const file = join(dir, 'board.db');
    // SQLite's default rollback-journal mode: switching it to WAL would rewrite the header.
    const fixture = new Database(file);
    fixture.exec('CREATE TABLE future (x INTEGER)');
    fixture.pragma('user_version = 99');
    fixture.close();
    const hash = sha256(readFileSync(file));

    expect(() => openStore(file)).toThrow(/v99/);

    expect(readdirSync(dir)).toEqual(['board.db']);
    expect(sha256(readFileSync(file))).toBe(hash);
  });

  it('backs up an unversioned file that already holds data', () => {
    const dir = tempDir();
    const file = join(dir, 'board.db');
    const fixture = new Database(file);
    fixture.exec('CREATE TABLE stray (x INTEGER); INSERT INTO stray VALUES (1);');
    fixture.close();

    const store = openStore(file);
    cleanup.push(() => store.close());

    expect(store.migration.from).toBe(0);
    expect(store.migration.backup).not.toBeNull();
    expect(backups(dir)).toHaveLength(1);
    const copy = new Database(join(dir, backups(dir)[0] ?? ''), { readonly: true });
    cleanup.push(() => copy.close());
    expect(copy.prepare('SELECT x FROM stray').pluck().all()).toEqual([1]);
  });

  it('rejects a gap or a misnamed migration file', () => {
    const gap = tempDir();
    writeFileSync(join(gap, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(gap, '0003_b.sql'), 'SELECT 1;');
    expect(() => readMigrations(pathToFileURL(`${gap}/`))).toThrow(/0003_b/);

    const misnamed = tempDir();
    writeFileSync(join(misnamed, '1_bad.sql'), 'SELECT 1;');
    expect(() => readMigrations(pathToFileURL(`${misnamed}/`))).toThrow(/1_bad\.sql/);
  });
});

describe('migration pins', () => {
  // sha256 of each migration file's raw bytes. A pinned file never changes: add a new file
  // and its pin instead. Changing the pin of an existing file is a review blocker.
  const PINS: Record<string, string> = {
    '0001_init.sql': 'b92894c23ff9a04e97e034ff9b2787f7be48660538dd861119e570ce1ab86f10',
    '0002_delivery.sql': '52180cad0a4577d8ad6a60eca748116f4ccd61142115581a3c9ea3a72d2cfa1d',
    '0003_delivery_search.sql': '3e915831a61930771096e91e17273a933cd8b5c2476aaec1c2d23b5f4fc2c755',
    '0004_attempt_started.sql': 'e2f659d551e9aaca510f1b84735eb451d8c8eac7bc8a4eeedd22487545f6f1f2',
  };

  interface MigrationFile {
    name: string;
    bytes: Buffer;
  }

  function checkPins(files: MigrationFile[], pins: Record<string, string>): string[] {
    const problems: string[] = [];
    for (const { name, bytes } of files) {
      const actual = sha256(bytes);
      const pinned = pins[name];
      if (pinned === undefined) {
        problems.push(`${name} has no pin; add '${name}': '${actual}' to PINS with the file`);
      } else if (pinned !== actual) {
        problems.push(
          `${name} changed (sha256 ${actual}, pinned ${pinned}); migrations are forward only: restore the file and add a new one`,
        );
      }
    }
    const names = new Set(files.map((file) => file.name));
    for (const name of Object.keys(pins)) {
      if (!names.has(name)) problems.push(`${name} is pinned but missing`);
    }
    return problems;
  }

  it('flags edited, missing and unpinned files and accepts a new file with its pin', () => {
    const a = { name: '0001_a.sql', bytes: Buffer.from('CREATE TABLE a (x INTEGER);\n') };
    const b = { name: '0002_b.sql', bytes: Buffer.from('CREATE TABLE b (x INTEGER);\n') };
    const pins = { [a.name]: sha256(a.bytes) };

    const edited = checkPins([{ ...a, bytes: Buffer.from('CREATE TABLE a (y INTEGER);\n') }], pins);
    expect(edited).toHaveLength(1);
    expect(edited[0]).toContain(a.name);

    const missing = checkPins([], pins);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain(a.name);

    const unpinned = checkPins([a, b], pins);
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]).toContain(`'${b.name}': '${sha256(b.bytes)}'`);

    expect(checkPins([a, b], { ...pins, [b.name]: sha256(b.bytes) })).toEqual([]);
  });

  it('matches every committed migration file', () => {
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => ({ name, bytes: readFileSync(new URL(name, migrationsDir)) }));
    expect(files.length).toBeGreaterThan(0);
    expect(checkPins(files, PINS)).toEqual([]);
  });
});
