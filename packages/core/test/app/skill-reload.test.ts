import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configSchema } from '@spur-board/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createSender, openStore, type Store } from '../../src/index.ts';
import { SpurRejectedError } from '../../src/app/sender.ts';
import { requestSkillReload, skillReloads } from '../../src/app/skill-reload.ts';
import { sampleRows } from '../store/sample-rows.ts';

const AT = new Date('2026-11-04T09:00:01.000Z');
const TEXT =
  'spur-board skill updated to 1.2.3. Before your next board command, read the spur-board skill file again: ~/.claude/skills/spur-board/SKILL.md (Claude Code) or $CODEX_HOME/skills/spur-board/SKILL.md, by default ~/.codex/skills/spur-board/SKILL.md (Codex).';
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
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'core-skill-reload-')), 'board.db'));
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
