import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tables } from '../../src/index.ts';
import {
  KEEP_BACKUPS,
  migrate,
  migrationsDir,
  pruneBackups,
  readMigrations,
  type Migration,
} from '../../src/store/migrate.ts';
import { openDatabase, openStore } from '../../src/store/store.ts';
import { insertSampleRows, sampleRows, tableNames } from './sample-rows.ts';

const INDEXES: Record<string, { table: string; columns: string[]; partialUnique: boolean }> = {
  task_stable_tracker_id: {
    table: 'task',
    columns: ['project', 'tracker_kind', 'tracker_id'],
    partialUnique: true,
  },
  link_pr_pair: { table: 'link', columns: ['task_id', 'repo', 'number'], partialUnique: true },
  link_session_pair: { table: 'link', columns: ['task_id', 'session_id'], partialUnique: true },
  link_ticket_pair: { table: 'link', columns: ['task_id', 'ticket_key'], partialUnique: true },
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
  notification_due: {
    table: 'notification',
    columns: ['acked_at', 'next_at'],
    partialUnique: false,
  },
  notification_block: {
    table: 'notification',
    columns: ['block_id', 'id'],
    partialUnique: false,
  },
  notification_turn: {
    table: 'notification',
    columns: ['turn_id', 'id'],
    partialUnique: false,
  },
  turn_one_unclosed: { table: 'turn', columns: ['task_id'], partialUnique: true },
  operator_item_active: {
    table: 'operator_item',
    columns: ['item_key', 'cleared_at'],
    partialUnique: false,
  },
  operator_token_status_expiry: {
    table: 'operator_token',
    columns: ['status', 'expires_at'],
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

/** Migration backups of `board.db`, exactly as `migrate` names them. */
function boardBackups(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => /^board\.db\.v\d+\.\d{8}T\d{9}Z\.bak$/.test(name))
    .sort();
}

/** `count` synthetic migrations after the real chain, each adding one table. */
function steps(count: number): Migration[] {
  return Array.from({ length: count }, (_, i) => ({
    version: latest + 1 + i,
    name: `${prefix(latest + 1 + i)}_step_${String(i)}`,
    sql: `CREATE TABLE step_${String(i)} (id INTEGER PRIMARY KEY) STRICT;`,
  }));
}

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

function withUmask<T>(mask: number, fn: () => T): T {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
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
    expect(readdirSync(dir).some((name) => name.endsWith('.partial'))).toBe(false);
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
    insertRaw(
      raw,
      'task',
      without(sampleRows.task, [
        'manual_include',
        'manual_exclude',
        'last_change_at',
        'terminal_at',
        'archive_slot_at',
        'reopened_at',
      ]),
    );
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

  it('keeps task and link identities when upgrading an existing observation-free store', () => {
    const dir = tempDir();
    const { raw } = rawDb(join(dir, 'board.db'));
    migrate(raw, real.slice(0, 4));
    insertRaw(
      raw,
      'task',
      without(sampleRows.task, [
        'manual_include',
        'manual_exclude',
        'last_change_at',
        'terminal_at',
        'archive_slot_at',
        'reopened_at',
      ]),
    );
    insertRaw(
      raw,
      'link',
      without(sampleRows.link, ['ticket_key', 'pr_open', 'reopen_hidden_at', 'reopen_pending_at']),
    );
    migrate(raw, real);
    expect(
      raw.prepare('SELECT id, tracker_id, key, manual_include, reopened_at FROM task').all(),
    ).toEqual([{ id: 1, tracker_id: '101', key: 'o/r#101', manual_include: 0, reopened_at: null }]);
    expect(raw.prepare('SELECT task_id, repo, number FROM link').all()).toEqual([
      { task_id: 1, repo: 'x/y', number: 7 },
    ]);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('backfills linked PR openness and preserves closed PR history', () => {
    const dir = tempDir();
    const { raw } = rawDb(join(dir, 'board.db'));
    migrate(raw, real.slice(0, 9));
    insertRaw(raw, 'task', without(sampleRows.task, ['reopened_at']));
    insertRaw(raw, 'pr_snapshot', { ...sampleRows.pr_snapshot, state: 'closed' });
    insertRaw(
      raw,
      'link',
      without(sampleRows.link, ['ticket_key', 'pr_open', 'reopen_hidden_at', 'reopen_pending_at']),
    );

    migrate(raw, real);

    expect(raw.prepare('SELECT id, source, ticket_key, pr_open FROM link').all()).toEqual([
      { id: 1, source: sampleRows.link.source, ticket_key: null, pr_open: 0 },
    ]);
    raw
      .prepare(
        `INSERT INTO link (task_id, entity, repo, number, pr_state, source, created_at, pr_open)
       VALUES (1, 'pr', 'x/y', 8, 'active', 'manual', ?, 1)`,
      )
      .run(sampleRows.link.created_at);
    expect(
      raw.prepare('SELECT number, pr_open FROM link WHERE entity = ? ORDER BY number').all('pr'),
    ).toEqual([
      { number: 7, pr_open: 0 },
      { number: 8, pr_open: 1 },
    ]);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO link (task_id, entity, repo, number, pr_state, source, created_at, pr_open)
         VALUES (1, 'pr', 'x/y', 9, 'active', 'manual', ?, 1)`,
        )
        .run(sampleRows.link.created_at),
    ).toThrow();
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps session snapshots and leaves them not confirmed absent', () => {
    const dir = tempDir();
    const { raw } = rawDb(join(dir, 'board.db'));
    migrate(raw, real.slice(0, 10));
    insertRaw(raw, 'session_snapshot', without(sampleRows.session_snapshot, ['absent_since']));

    migrate(raw, real);

    expect(raw.prepare('SELECT id, last_seen, absent_since FROM session_snapshot').all()).toEqual([
      {
        id: sampleRows.session_snapshot.id,
        last_seen: sampleRows.session_snapshot.last_seen,
        absent_since: null,
      },
    ]);
  });

  it('preserves shared operator item IDs when upgrading a version 7 store', () => {
    const dir = tempDir();
    const { raw } = rawDb(join(dir, 'board.db'));
    migrate(raw, real.slice(0, 7));
    insertRaw(
      raw,
      'task',
      without(sampleRows.task, [
        'manual_include',
        'manual_exclude',
        'last_change_at',
        'terminal_at',
        'archive_slot_at',
        'reopened_at',
      ]),
    );
    insertRaw(
      raw,
      'operator_item',
      without(
        {
          ...sampleRows.operator_item,
          block_id: null,
          line_outbox_id: null,
        },
        ['fingerprint', 'fact_at', 'source', 'priority'],
      ),
    );
    const result = migrate(raw, real.slice(0, 10));
    expect(result).toMatchObject({
      from: 7,
      to: 10,
      applied: ['0008_observation', '0009_operator_tokens', '0010_manual_links'],
    });
    expect(
      raw
        .prepare('SELECT id, item_key, fingerprint, fact_at, source, priority FROM operator_item')
        .all(),
    ).toEqual([
      {
        id: 1,
        item_key: sampleRows.operator_item.item_key,
        fingerprint: null,
        fact_at: null,
        source: null,
        priority: null,
      },
    ]);
    expect(tables(raw)).not.toContain('from_you_item');
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('rebuilds notification with a turn owner', () => {
    const dir = tempDir();
    const { raw } = rawDb(join(dir, 'board.db'));
    migrate(raw, real.slice(0, 11));
    insertRaw(raw, 'task', without(sampleRows.task, ['reopened_at']));
    insertRaw(raw, 'block', sampleRows.block);
    const old = without(
      { ...sampleRows.notification, author_session: null, last_outbox_id: null },
      ['turn_id'],
    );
    insertRaw(raw, 'notification', old);
    insertRaw(raw, 'notification', { ...old, id: 7, source_key: 'removed:1', kind: 'removed' });
    raw.prepare("UPDATE sqlite_sequence SET seq = 20 WHERE name = 'notification'").run();

    migrate(raw, real);

    expect(rows(raw, 'notification')).toEqual([
      { ...old, turn_id: null },
      { ...old, id: 7, source_key: 'removed:1', kind: 'removed', turn_id: null },
    ]);
    insertRaw(raw, 'turn', { ...sampleRows.turn, closed_at: null, closed_reason: null });
    const insert = (row: Record<string, unknown>) => {
      insertRaw(raw, 'notification', without({ ...old, ...row }, ['id']));
    };
    insert({ source_key: 'turn:1:worker', kind: 'turn', block_id: null, turn_id: 1 });
    expect(
      raw.prepare("SELECT id FROM notification WHERE source_key = 'turn:1:worker'").pluck().get(),
    ).toBe(21);
    expect(() => {
      insert({ source_key: 'turn:1:a', kind: 'turn', block_id: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      insert({ source_key: 'turn:1:b', kind: 'turn', turn_id: 1 });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      insert({ source_key: 'block:1:c', block_id: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      insert({ source_key: 'block:1:d', turn_id: 1 });
    }).toThrow(/CHECK constraint failed/);
    expect(raw.pragma('foreign_key_check')).toEqual([]);
  });

  it('rebuilds notification with a turn reminder kind', () => {
    const dir = tempDir();
    const { raw } = rawDb(join(dir, 'board.db'));
    migrate(raw, real.slice(0, 12));
    insertRaw(raw, 'task', without(sampleRows.task, ['reopened_at']));
    insertRaw(raw, 'block', sampleRows.block);
    insertRaw(raw, 'turn', {
      ...without(sampleRows.turn, ['head_sha']),
      closed_at: null,
      closed_reason: null,
    });
    const block = { ...sampleRows.notification, author_session: null, last_outbox_id: null };
    const turn = { ...block, id: 7, source_key: 'turn:1:worker', kind: 'turn', block_id: null };
    insertRaw(raw, 'notification', block);
    insertRaw(raw, 'notification', { ...turn, turn_id: 1 });
    raw.prepare("UPDATE sqlite_sequence SET seq = 30 WHERE name = 'notification'").run();

    migrate(raw, real);

    expect(rows(raw, 'notification')).toEqual([block, { ...turn, turn_id: 1 }]);
    const insert = (row: Record<string, unknown>) => {
      insertRaw(raw, 'notification', without({ ...block, ...row }, ['id']));
    };
    insert({
      source_key: 'turn:1:reminder:worker-1',
      kind: 'turn_reminder',
      block_id: null,
      turn_id: 1,
    });
    expect(
      raw
        .prepare("SELECT id FROM notification WHERE source_key = 'turn:1:reminder:worker-1'")
        .pluck()
        .get(),
    ).toBe(31);
    expect(() => {
      insert({ source_key: 'turn:1:reminder:a', kind: 'turn_reminder', block_id: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      insert({ source_key: 'turn:1:reminder:b', kind: 'turn_reminder', turn_id: 1 });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      insert({ source_key: 'turn:1:c', kind: 'turn', block_id: null });
    }).toThrow(/CHECK constraint failed/);
    expect(() => {
      insert({ source_key: 'block:1:d', turn_id: 1 });
    }).toThrow(/CHECK constraint failed/);
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

  it('keeps only the newest KEEP_BACKUPS backups after repeated upgrades', async () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    const { raw, db } = rawDb(join(dir, 'board.db'));
    migrate(raw, real);
    await insertSampleRows(db);
    const decoys = [
      'board.db.v1.20200101T000000000Z.bak.partial',
      'other.db.v1.20200101T000000000Z.bak',
      'board.db.v1.x.bak',
    ];
    for (const name of decoys) writeFileSync(join(dir, name), 'decoy');
    const chain = steps(KEEP_BACKUPS + 2);

    let last: string | null = null;
    withUmask(0o022, () => {
      for (let i = 1; i <= chain.length; i++) {
        last = migrate(raw, [...real, ...chain.slice(0, i)]).backup;
      }
    });

    const kept = boardBackups(dir);
    const versions = kept
      .map((name) => Number(/^board\.db\.v(\d+)\./.exec(name)?.[1]))
      .sort((a, b) => a - b);
    expect(versions).toEqual(
      Array.from({ length: KEEP_BACKUPS }, (_, i) => latest + chain.length - KEEP_BACKUPS + i),
    );
    expect(last).not.toBeNull();
    expect(kept.map((name) => join(dir, name))).toContain(last);
    for (const name of kept) expect(mode(join(dir, name))).toBe(0o600);
    for (const name of decoys) expect(existsSync(join(dir, name))).toBe(true);
  });

  it('never prunes the backup it just wrote when older backups carry later stamps', async () => {
    const dir = tempDir();
    const { raw, db } = rawDb(join(dir, 'board.db'));
    migrate(raw, real);
    await insertSampleRows(db);
    const future = (k: number): string => `board.db.v1.2999010${String(k)}T000000000Z.bak`;
    for (let k = 1; k <= KEEP_BACKUPS; k++) writeFileSync(join(dir, future(k)), 'old');

    const result = migrate(raw, [...real, ...steps(1)]);

    expect(result.backup).not.toBeNull();
    expect(existsSync(result.backup ?? '')).toBe(true);
    expect(boardBackups(dir)).toHaveLength(KEEP_BACKUPS);
    expect(existsSync(join(dir, future(1)))).toBe(false);
    for (let k = 2; k <= KEEP_BACKUPS; k++) expect(existsSync(join(dir, future(k)))).toBe(true);
  });

  it('leaves a directory and a symlink with a backup name untouched', () => {
    const dir = tempDir();
    const outside = tempDir();
    const target = join(outside, 'target');
    writeFileSync(target, 'not a backup');
    chmodSync(target, 0o644);
    const folder = join(dir, 'board.db.v1.29990101T000000000Z.bak');
    mkdirSync(folder, { mode: 0o755 });
    chmodSync(folder, 0o755);
    const link = join(dir, 'board.db.v1.29990102T000000000Z.bak');
    symlinkSync(target, link);
    const stamp = (k: number): string => `board.db.v1.2020010${String(k)}T000000000Z.bak`;
    for (let k = 1; k <= KEEP_BACKUPS; k++) writeFileSync(join(dir, stamp(k)), 'old');

    pruneBackups(join(dir, 'board.db'));

    expect(statSync(folder).isDirectory()).toBe(true);
    expect(mode(folder)).toBe(0o755);
    expect(readlinkSync(link)).toBe(target);
    expect(mode(target)).toBe(0o644);
    for (let k = 1; k <= KEEP_BACKUPS; k++) expect(mode(join(dir, stamp(k)))).toBe(0o600);
  });

  // Root can unlink files in a read-only directory, so the removal would not fail.
  it.skipIf(process.getuid?.() === 0)('keeps going when an old backup cannot be removed', () => {
    const dir = tempDir();
    const stamp = (k: number): string => `board.db.v1.2020010${String(k)}T000000000Z.bak`;
    for (let k = 1; k <= KEEP_BACKUPS + 1; k++) {
      writeFileSync(join(dir, stamp(k)), 'old');
      chmodSync(join(dir, stamp(k)), 0o644);
    }
    chmodSync(dir, 0o555);
    try {
      expect(() => {
        pruneBackups(join(dir, 'board.db'));
      }).not.toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }

    expect(existsSync(join(dir, stamp(1)))).toBe(true);
    for (let k = 1; k <= KEEP_BACKUPS + 1; k++) expect(mode(join(dir, stamp(k)))).toBe(0o600);
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
    '0005_doorbells_items.sql': '6d1a269b593d0f6b342a73761f1a756a94a6c9c2a5c983c191a627654b097570',
    '0006_notification_exhausted.sql':
      '64139694f1bde3e61d7c1b67ebc9eb4858c3974bdd72f84306ac3837f7d8de96',
    '0007_inbound_item_event.sql':
      '205aad5987530bce0bd2a96ec5ce836cf76b176e366e27735d1fff692650b8eb',
    '0008_observation.sql': '4bde8ddb6da6dbffa22f270fc8b442c9670bef51ef106e2600bcbba958ecd2eb',
    '0009_operator_tokens.sql': [
      '4a34cd8b138b546fcf1817d510d16639',
      '712f01c6d65901a62e2a199b770ee62a',
    ].join(''),
    '0010_manual_links.sql': '40142af689b91dd9ffbf835baa831534a91498bce4685299b3c66ff45513bbee',
    '0011_session_absent_since.sql':
      '6522f14d6984e4c0af5b1330b5bc7acacee97906e59d20a08f0437fe551d7c46',
    '0012_turn.sql': '181f5fbcc24e1af558471ceaecf76589c314f26813742b057ed84c68f4ea9a8d',
    '0013_turn_reminder.sql': '5843346871e99e0de1fd655f0402fb162dab583318a24c0baf51c7504b71053b',
    '0014_dispatcher.sql': 'cbb8ee72ad4fff5bb1eeeaff95eebf93da3e92d902e42eee3e69d98aec11a2b5',
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
