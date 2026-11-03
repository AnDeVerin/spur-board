import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LINK_SOURCES, SESSION_LINK_ROLES } from '@spur-board/contracts';
import Database from 'better-sqlite3';
import { sql, type Insertable } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import { openStore, parseJson, toJson, type Store, type Tables } from '../../src/index.ts';
import { insertSampleRows, sampleRows, tableNames } from './sample-rows.ts';

const open: Store[] = [];

function freshStore(): { store: Store; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'core-store-')), 'board.db');
  const store = openStore(file);
  open.push(store);
  return { store, file };
}

afterEach(async () => {
  for (const store of open.splice(0)) await store.close();
});

async function pragma(store: Store, name: string): Promise<unknown> {
  const { rows } = await sql<Record<string, unknown>>`PRAGMA ${sql.raw(name)}`.execute(store.db);
  return Object.values(rows[0] ?? {})[0];
}

describe('openStore', () => {
  it('sets WAL, NORMAL sync, foreign keys and busy timeout on open', async () => {
    const { store } = freshStore();
    expect(await pragma(store, 'journal_mode')).toBe('wal');
    expect(await pragma(store, 'synchronous')).toBe(1);
    expect(await pragma(store, 'foreign_keys')).toBe(1);
    expect(await pragma(store, 'busy_timeout')).toBe(5000);
  });

  it('round-trips one row per table', async () => {
    const { store } = freshStore();
    await insertSampleRows(store.db);
    for (const table of tableNames) {
      expect(await store.db.selectFrom(table).selectAll().execute()).toEqual([sampleRows[table]]);
      const { rows } = await sql<{
        name: string;
      }>`select name from pragma_table_info(${table})`.execute(store.db);
      expect(rows.map((row) => row.name)).toEqual(Object.keys(sampleRows[table]));
    }
    expect(Object.keys(sampleRows.submission)).toEqual([
      'id',
      'task_id',
      'column',
      'epoch',
      'commit_sha',
      'author',
      'submitted_at',
      'note',
    ]);
  });

  it('enforces the unique keys', async () => {
    const { store } = freshStore();
    const { db } = store;
    await insertSampleRows(db);
    const t2 = { ...sampleRows.task, id: 2, tracker_id: '102' };
    await db.insertInto('task').values(t2).execute();
    const prLink = (
      taskId: number,
      repo: string,
      number: number,
      prState: 'active' | 'conflict',
      banned: 0 | 1 = 0,
    ): Insertable<Tables['link']> => ({
      task_id: taskId,
      entity: 'pr',
      repo,
      number,
      pr_state: prState,
      source: LINK_SOURCES[0],
      banned,
      created_at: t2.created_at,
    });
    const sessionLink = (sessionId: string): Insertable<Tables['link']> => ({
      task_id: t2.id,
      entity: 'session',
      session_id: sessionId,
      role: SESSION_LINK_ROLES[0],
      source: LINK_SOURCES[0],
      banned: 0,
      created_at: t2.created_at,
    });
    await db
      .insertInto('link')
      .values(prLink(t2.id, 'o/r', 1, 'active'))
      .execute();
    await db.insertInto('link').values(sessionLink('s1')).execute();

    const rejected = [
      db.insertInto('command').values({ ...sampleRows.command, operation: 'other' }),
      db.insertInto('outbox').values({ ...sampleRows.outbox, id: 2 }),
      db.insertInto('link').values(prLink(t2.id, 'o/r', 2, 'active')),
      db.insertInto('link').values(prLink(t2.id, 'o/r', 1, 'conflict')),
      db.insertInto('link').values(sessionLink('s1')),
      // NULL identities would slip past the unique indexes; the CHECKs stop them.
      db.insertInto('link').values({ ...prLink(t2.id, 'o/r', 5, 'conflict'), repo: null }),
      db.insertInto('link').values({ ...prLink(t2.id, 'o/r', 6, 'conflict'), number: null }),
      db.insertInto('link').values({ ...prLink(t2.id, 'o/r', 7, 'conflict'), pr_state: null }),
      db.insertInto('link').values({ ...sessionLink('s3'), session_id: null }),
      db.insertInto('conversation').values({ ...sampleRows.conversation, space: 'feed' }),
      db.insertInto('transport_health').values({ ...sampleRows.transport_health, reason: 'down' }),
      db.insertInto('space_slot').values(sampleRows.space_slot),
    ];
    for (const query of rejected) {
      await expect(query.execute()).rejects.toMatchObject({
        code: expect.stringMatching(/^SQLITE_CONSTRAINT_/) as unknown,
      });
    }

    await db
      .insertInto('link')
      .values(prLink(t2.id, 'o/r', 3, 'conflict'))
      .execute();
    await db
      .insertInto('link')
      .values(prLink(t2.id, 'o/r', 4, 'active', 1))
      .execute();
    await db.insertInto('link').values(sessionLink('s2')).execute();
    await db
      .insertInto('link')
      .values(prLink(sampleRows.link.task_id, 'o/r', 1, 'conflict'))
      .execute();
    // Idempotency keys belong to the caller: another agent may reuse the same key.
    await db
      .insertInto('command')
      .values({ ...sampleRows.command, actor: 'agent:proj/sess-2' })
      .execute();
    await db
      .insertInto('submission')
      .values({ ...sampleRows.submission, id: 2, commit_sha: 'c'.repeat(40) })
      .execute();
    expect(await db.selectFrom('submission').select('id').execute()).toHaveLength(2);
    // Conversation refs are unique per gateway only; health and slots are per (gateway, space).
    await db
      .insertInto('conversation')
      .values({ ...sampleRows.conversation, gateway: 'fake-telegram-like' })
      .execute();
    await db
      .insertInto('transport_health')
      .values({ ...sampleRows.transport_health, space: 'feed' })
      .execute();
    expect(await db.selectFrom('conversation').select('ref').execute()).toHaveLength(2);
    expect(await db.selectFrom('transport_health').select('space').execute()).toHaveLength(2);
    await db
      .insertInto('space_slot')
      .values({ ...sampleRows.space_slot, space: 'feed' })
      .execute();
    expect(await db.selectFrom('space_slot').select('space').execute()).toHaveLength(2);
  });
});

describe('store.transaction', () => {
  it('commits on return and holds the write lock from BEGIN', async () => {
    const { store, file } = freshStore();
    await store.transaction(async (trx) => {
      const probe = new Database(file, { timeout: 0 });
      try {
        expect(() => probe.exec('BEGIN IMMEDIATE')).toThrow(
          expect.objectContaining({ code: 'SQLITE_BUSY' }),
        );
      } finally {
        probe.close();
      }
      await trx.insertInto('meta').values(sampleRows.meta).execute();
    });
    const reader = new Database(file, { readonly: true });
    try {
      expect(reader.prepare('select * from meta').all()).toEqual([sampleRows.meta]);
    } finally {
      reader.close();
    }
  });

  it('rolls back a write when the function throws', async () => {
    const { store } = freshStore();
    const failure = new Error('boom');
    await expect(
      store.transaction(async (trx) => {
        await trx.insertInto('meta').values(sampleRows.meta).execute();
        throw failure;
      }),
    ).rejects.toBe(failure);
    const { count } = await store.db
      .selectFrom('meta')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .executeTakeFirstOrThrow();
    expect(count).toBe(0);
  });
});

describe('JSON columns', () => {
  it('parseJson and toJson reject values that fail the schema', () => {
    const schema = z.object({ n: z.int() });
    expect(() => parseJson(schema, '{"n":"x"}')).toThrow(ZodError);
    expect(() => parseJson(schema, '{"n":')).toThrow(SyntaxError);
    expect(() => toJson(schema, { n: 1.5 })).toThrow(ZodError);
    expect(parseJson(schema, toJson(schema, { n: 3 }))).toEqual({ n: 3 });
  });
});
