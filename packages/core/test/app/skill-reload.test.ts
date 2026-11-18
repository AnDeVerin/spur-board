import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createSender, type Store } from '../../src/index.ts';
import { SpurRejectedError } from '../../src/app/sender.ts';
import { requestSkillReload, skillReloads } from '../../src/app/skill-reload.ts';
import { sampleRows } from '../store/sample-rows.ts';
import { openTempStore } from '../support/store.ts';

const AT = new Date('2026-11-04T09:00:01.000Z');
const TEXT =
  'spur-board skill updated to 1.2.3. Before your next board command, read the spur-board skill again, SKILL.md and every file in its references/ folder: ~/.claude/skills/spur-board/ (Claude Code) or $CODEX_HOME/skills/spur-board/, by default ~/.codex/skills/spur-board/ (Codex).';
const FIRST_SEEN = Date.parse(sampleRows.session_snapshot.first_seen);
const BEFORE_FIRST_SEEN = new Date(FIRST_SEEN - 60_000).toISOString();
const AFTER_FIRST_SEEN = new Date(FIRST_SEEN + 60_000).toISOString();
const PATHS =
  '~/.claude/skills/spur-board/ (Claude Code) or $CODEX_HOME/skills/spur-board/, by default ~/.codex/skills/spur-board/ (Codex).';
function named(version: string, names: string): string {
  return `spur-board skill updated to ${version}. Before your next board command, read these files of the spur-board skill again: ${names}. They are under ${PATHS}`;
}
const config = configSchema.parse({
  projects: [
    {
      id: 'proj',
      tracker: { type: 'github-issues', repo: 'o/r', milestone: 'M1' },
      repos: ['o/r'],
      operatorGithubLogin: 'operator',
      spurProjects: [
        { name: 'web', role: 'worker' },
        { name: 'desk', role: 'curator' },
      ],
    },
  ],
  operator: { slack: 'operator' },
  digest: { tz: 'UTC' },
});
const stores: Store[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

async function setup() {
  const store = openTempStore('core-skill-reload-').store;
  stores.push(store);
  const ended = AT.toISOString();
  await store.transaction(async (trx) => {
    await trx.insertInto('task').values(sampleRows.task).execute();
    const sessions = [
      { id: 'linked', spur_project: 'web', state: 'waiting' },
      { id: 'unlinked', spur_project: 'desk', state: 'running' },
      { id: 'ended', spur_project: 'web', state: 'waiting', ended_at: ended },
      { id: 'absent', spur_project: 'web', state: 'waiting', absent_since: ended },
      { id: 'completed', spur_project: 'web', state: 'completed' },
      { id: 'foreign-1', spur_project: 'foreign', state: 'waiting' },
    ];
    for (const session of sessions) {
      await trx
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          ended_at: null,
          end_reason: null,
          absent_since: null,
          ...session,
        })
        .execute();
    }
    await trx
      .insertInto('link')
      .values({
        ...sampleRows.link,
        entity: 'session',
        repo: null,
        number: null,
        pr_state: null,
        session_id: 'linked',
        role: 'worker',
      })
      .execute();
  });
  const sent: { session: string; text: string }[] = [];
  let reject = false;
  const sender = createSender({
    store,
    config,
    spur: {
      send(session, text) {
        if (reject) return Promise.reject(new SpurRejectedError('unknown session'));
        sent.push({ session, text });
        return Promise.resolve();
      },
    },
    now: () => AT,
  });
  return {
    store,
    sent,
    async addSession(id: string) {
      await store.db
        .insertInto('session_snapshot')
        .values({
          ...sampleRows.session_snapshot,
          ended_at: null,
          end_reason: null,
          absent_since: null,
          id,
          spur_project: 'web',
          state: 'waiting',
        })
        .execute();
    },
    async texts(version: string) {
      const rows = await store.db
        .selectFrom('outbox')
        .select(['dedupe_key', 'payload'])
        .where('dedupe_key', 'like', `doorbell:skill-reload:${version}:%`)
        .orderBy('dedupe_key')
        .execute();
      return Object.fromEntries(
        rows.map((row) => {
          const payload = JSON.parse(row.payload) as { session: string; text: string };
          return [payload.session, payload.text];
        }),
      );
    },
    async setState(version: string, session: string, state: 'done' | 'dead' | 'pending') {
      await store.db
        .updateTable('outbox')
        .set({ state })
        .where('dedupe_key', '=', `doorbell:skill-reload:${version}:${session}`)
        .execute();
    },
    async ticks(count: number) {
      for (let tick = 0; tick < count; tick += 1) await sender.tick();
    },
    reject(on: boolean) {
      reject = on;
    },
  };
}

describe('requestSkillReload', () => {
  it('queues one message per live session of a configured Spur project and sends it once', async () => {
    expect(TEXT.length).toBeLessThanOrEqual(600);
    const ctx = await setup();
    expect(await requestSkillReload(ctx.store, config, '1.2.3', AT)).toEqual({ queued: 2 });
    const rows = await ctx.store.db
      .selectFrom('outbox')
      .select(['kind', 'dedupe_key', 'payload', 'state'])
      .orderBy('dedupe_key')
      .execute();
    expect(rows).toEqual(
      ['linked', 'unlinked'].map((session) => ({
        kind: 'doorbell',
        dedupe_key: `doorbell:skill-reload:1.2.3:${session}`,
        payload: JSON.stringify({ session, text: TEXT, queuedAt: AT.toISOString() }),
        state: 'pending',
      })),
    );

    await ctx.ticks(3);
    expect(ctx.sent.toSorted((a, b) => a.session.localeCompare(b.session))).toEqual([
      { session: 'linked', text: TEXT },
      { session: 'unlinked', text: TEXT },
    ]);

    expect(await requestSkillReload(ctx.store, config, '1.2.3', AT)).toEqual({ queued: 0 });
    await ctx.ticks(3);
    expect(ctx.sent).toHaveLength(2);
  });

  it('queues nothing when every listed file is older than the session or its delivered reload', async () => {
    const ctx = await setup();
    expect(
      await requestSkillReload(ctx.store, config, '1.2.3', AT, { 'SKILL.md': BEFORE_FIRST_SEEN }),
    ).toEqual({ queued: 0 });
    const files = { 'SKILL.md': BEFORE_FIRST_SEEN, 'references/a.md': AFTER_FIRST_SEEN };
    expect(await requestSkillReload(ctx.store, config, '1.2.3', AT, files)).toEqual({ queued: 2 });
    await ctx.ticks(3);
    expect(ctx.sent).toHaveLength(2);

    const later = new Date(AT.getTime() + 60_000);
    expect(await requestSkillReload(ctx.store, config, '1.2.4', later, files)).toEqual({
      queued: 0,
    });
    expect(await ctx.texts('1.2.4')).toEqual({});
  });

  it('names only the reference that changed after the session was first seen', async () => {
    const ctx = await setup();
    const files = { 'SKILL.md': BEFORE_FIRST_SEEN, 'references/inbox.md': AFTER_FIRST_SEEN };
    expect(await requestSkillReload(ctx.store, config, '1.2.3', AT, files)).toEqual({ queued: 2 });
    const text = named('1.2.3', 'references/inbox.md');
    expect(text.length).toBeLessThanOrEqual(600);
    expect(await ctx.texts('1.2.3')).toEqual({ linked: text, unlinked: text });
  });

  it('names SKILL.md first when it changed with a reference', async () => {
    const ctx = await setup();
    const files = { 'references/x.md': AFTER_FIRST_SEEN, 'SKILL.md': AFTER_FIRST_SEEN };
    await requestSkillReload(ctx.store, config, '1.2.3', AT, files);
    const text = named('1.2.3', 'SKILL.md, references/x.md');
    expect(await ctx.texts('1.2.3')).toEqual({ linked: text, unlinked: text });
  });

  it('moves the baseline only for delivered rows and catches up a dead or pending one', async () => {
    const ctx = await setup();
    await ctx.addSession('waiting');
    const files = { 'SKILL.md': BEFORE_FIRST_SEEN, 'references/x.md': AFTER_FIRST_SEEN };
    expect(await requestSkillReload(ctx.store, config, '1.2.3', AT, files)).toEqual({ queued: 3 });
    await ctx.setState('1.2.3', 'linked', 'done');
    await ctx.setState('1.2.3', 'unlinked', 'dead');

    const later = new Date(AT.getTime() + 60_000);
    expect(await requestSkillReload(ctx.store, config, '1.2.4', later, files)).toEqual({
      queued: 2,
    });
    const text = named('1.2.4', 'references/x.md');
    expect(await ctx.texts('1.2.4')).toEqual({ unlinked: text, waiting: text });
  });

  it('names a file changed after the newest delivered reload', async () => {
    const ctx = await setup();
    await requestSkillReload(ctx.store, config, '1.2.3', AT, {
      'references/x.md': AFTER_FIRST_SEEN,
    });
    await ctx.ticks(3);
    const later = new Date(AT.getTime() + 60_000);
    const files = {
      'references/x.md': AFTER_FIRST_SEEN,
      'references/y.md': new Date(AT.getTime() + 30_000).toISOString(),
    };
    expect(await requestSkillReload(ctx.store, config, '1.2.4', later, files)).toEqual({
      queued: 2,
    });
    const text = named('1.2.4', 'references/y.md');
    expect(await ctx.texts('1.2.4')).toEqual({ linked: text, unlinked: text });
  });

  it.each([
    ['seven names', Array.from({ length: 7 }, (_, i) => `references/r${String(i)}.md`)],
    [
      'six names over 600 characters',
      Array.from({ length: 6 }, (_, i) => `references/${String(i)}${'a'.repeat(63)}.md`),
    ],
  ])('asks for every file for %s', async (_name, names) => {
    const ctx = await setup();
    const files = Object.fromEntries(names.map((name) => [name, AFTER_FIRST_SEEN]));
    await requestSkillReload(ctx.store, config, '1.2.3', AT, files);
    expect(await ctx.texts('1.2.3')).toEqual({ linked: TEXT, unlinked: TEXT });
  });

  it('queues nothing when no Spur project is configured', async () => {
    const ctx = await setup();
    const empty = configSchema.parse({
      ...config,
      projects: [{ ...config.projects[0], spurProjects: [] }],
    });
    expect(await requestSkillReload(ctx.store, empty, '1.2.3', AT)).toEqual({ queued: 0 });
  });
});

describe('skillReloads', () => {
  it('maps the delivery of named sessions only, pending before the send and delivered after', async () => {
    const ctx = await setup();
    await requestSkillReload(ctx.store, config, '1.2.3', AT);
    const named = ['unlinked', 'linked', 'ended', 'never'];
    expect(await skillReloads(ctx.store.db, '1.2.3', named)).toEqual([
      { id: 'linked', state: 'pending', queuedAt: AT.toISOString() },
      { id: 'unlinked', state: 'pending', queuedAt: AT.toISOString() },
    ]);
    expect(await skillReloads(ctx.store.db, '1.2.3', ['linked'])).toEqual([
      { id: 'linked', state: 'pending', queuedAt: AT.toISOString() },
    ]);

    await ctx.ticks(3);
    expect(await skillReloads(ctx.store.db, '1.2.3', named)).toEqual([
      { id: 'linked', state: 'delivered', queuedAt: AT.toISOString() },
      { id: 'unlinked', state: 'delivered', queuedAt: AT.toISOString() },
    ]);
    expect(await skillReloads(ctx.store.db, '9.9.9', named)).toEqual([]);
  });

  it('reports failed when Spur rejects the message', async () => {
    const ctx = await setup();
    await requestSkillReload(ctx.store, config, '1.2.3', AT);
    await ctx.ticks(3);
    ctx.reject(true);
    expect(await requestSkillReload(ctx.store, config, '1.3.0-rc.1', AT)).toEqual({ queued: 2 });
    await ctx.ticks(3);
    expect(await skillReloads(ctx.store.db, '1.3.0-rc.1', ['linked', 'unlinked'])).toEqual([
      { id: 'linked', state: 'failed', queuedAt: AT.toISOString() },
      { id: 'unlinked', state: 'failed', queuedAt: AT.toISOString() },
    ]);
    expect(await skillReloads(ctx.store.db, '1.2.3', ['linked'])).toEqual([
      { id: 'linked', state: 'delivered', queuedAt: AT.toISOString() },
    ]);
  });
});
