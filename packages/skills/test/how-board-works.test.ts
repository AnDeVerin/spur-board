import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ITEM_KINDS } from '../../contracts/src/index.ts';

describe('how the Board works guide', () => {
  it.each([
    {
      section: 'Columns and executors',
      topic: 'columns',
      clauses: [
        /`todo`, `triage`, `ready-for-dev`, `dev`, `review`, `product-review`,\s*`external-review`, `qa`, `ready-to-merge`, `done`/,
        /Todo group is `todo`, `triage` and `ready-for-dev`/,
        /never moves a task between them/,
        /Each column has one executor/,
        /worker owns the code and branch/,
        /`worker`, `operator`, `curator` and\s*`orchestrator`/,
        /project with role\s*`orchestrator` or `curator`/,
        /board-wide/,
        /project-level binding wins/,
      ],
      keys: [
        'projects[].columns[].enabled',
        'projects[].columns[].orchestrator',
        'projects[].spurProjects[].role',
        'spurProjects[].columns',
      ],
    },
    {
      section: 'Gates and placement',
      topic: 'columns',
      clauses: [
        /default is `shadow`/,
        /Facts \(head, checks, reviews, comments, ticket, sessions\) feed gates/,
        /two actions: move the task and open an executor turn/,
        /at most one\s*per evaluation/,
        /Turns follow unmet entry gates, actionable post-submit failures,\s*rerouting or Done wrap-up/,
        /Holds and existing turns can yield neither action/,
        /current-head internal review marks, separate from\s*External Review's external approval/,
        /PR closed without merge with no open PR/,
        /closed\s*ticket with live work and no merged PR/,
        /`board status` lists them[\s\S]*operator block threads/,
        /Gates are cumulative: each column checks its enabled gate and those to its left/,
        /turn boundary[\s\S]*leftmost failing\s*column/,
        /Pending CI, unknown\s*mergeability and incomplete comment history are waits/,
        /Downstream handoff waits\s*for settled prerequisites; Dev can receive a repair turn/,
        /status comment whose last line is a hidden `board-reviewer-progress` or\s*`board-reviewer-unavailable` marker is not external feedback/,
        /mark lasts across visits on the current head/,
        /visit\s*submission belongs to one column visit/,
        /New heads invalidate internal Review and Product Review marks/,
        /Taken turns hold until submit, return or a new head/,
        /Fixed gate rules have no configuration switch/,
        /Fixed gate rules have no configuration switch\s*except enabled columns, no-CI, checks gate and resolved threads/,
        /`projects\[\]\.checksGate` \(default `dev`/,
        /Red\s*checks return the task to Dev from any column, after the submit of a taken turn/,
        /Only right of `dev` a cancelled check counts as running\s*for about two GitHub poll intervals/,
        /takes effect after a restart/,
        /`projects\[\]\.columns\[\]\.requireResolvedThreads` \(default: `ready-to-merge` only\)\s*gates that column and those right of it/,
        /an unresolved review thread, outdated\s*or by anyone, returns the task to Dev, whose turn lists each thread link/,
        /worker fixes or answers, then resolves each; reviewers never do/,
        /Dev submit on the same head moves right, keeping marks and approval/,
        /approval's inline notes are threads; it still passes External Review/,
        /Feedback excludes\s+bots, approvals and `projects\[\]\.operatorGithubLogin`\s+\(agents'\s+account\), so worker\s+thread replies never count/,
        /never count; others' posts do\./,
        /repo owner's and the human operator's own accounts count too, unless one is\s+that login/,
        /a PR comment is a change request; talk to agents in Slack\s+\(`@shortName`\) or the Board/,
        /A review-thread reply is a new review/,
        /An approval\s+hides its inline comments; thread resolution and the head a comment was left on\s+change nothing/,
        /Bots \(GitHub Apps\) neither return a task, approve it nor block\s+an approval; their threads still count/,
        /Handled means handed by ID to a Dev turn, not answered; in shadow\s+mode, a later submit in Dev or an executor `none` column handles it/,
        /An edit after the hand makes it unhandled again, returning a task right of Dev/,
      ],
      keys: [
        'projects[].dispatcher.mode: on',
        'projects[].reposWithoutCi',
        'projects[].operatorGithubLogin',
        'projects[].columns[].requireResolvedThreads',
      ],
    },
    {
      section: 'Turns and delivery',
      topic: 'turns',
      clauses: [
        /turn `T<number>`/,
        /Only the acknowledging session may submit\s*or return/,
        /`board inbox ack <entries>`/,
        /`board submit <turn> <sha>`/,
        /`board return <turn> <reason>`/,
        /new head closes taken turns outside Dev and Done; taken Dev turns and Done\s+wrap-up turns survive pushes, and a wrap-up turn closes when its holder ends/,
        /Closed turns receive no further Board sends/,
        /Obsolete queued rings are dropped/,
        /message already accepted by Spur cannot be retracted/,
        /Check `board inbox` and\s*act only on a current turn/,
        /shadow mode, use keyed `board submit <task> <sha>`/,
        /answer `pending`: that submit is final/,
        /do not resubmit or raise a\s*block/,
        /Right of Dev, red CI, a draft, a conflict, an external comment or an unresolved\s+thread where required returns the\s+task to Dev at once, unless a turn is taken; then after its submit or return/,
        /The Dev turn hands the comments, beside a return's `code` block/,
        /Each handed entry has its `url`, `editedAt` once edited, and a review's inline\s+`comments` with `url` and `threadId`/,
        /Turns of a Dev visit opened by a return\s+show `returned`: who, from, the turn, the `code` block and the verbatim reason/,
        /journal events `turn_opened`,\s*`turn_taken` and `turn_closed`/,
      ],
      keys: ['projects[].dispatcher.submitConfirmMs'],
    },
    {
      section: 'Doorbells',
      topic: 'turns',
      clauses: [
        /A turn opened for you by your own confirmed submit or return is first rung only after `doorbells.firstRetryMs`; a turn opened for you any other way rings at once\./,
        /doorbell expects action: read `board inbox`/,
        /turn, addressed\s*block, answer or follow-up/,
        /Ordinary task comments do not ring/,
        /block\s*tracked by its author role ring itself/,
        /up to three delivered rings/,
        /acknowledgement stops them/,
        /Removal notices and quiet-turn reminders ring once/,
        /Busy recipients defer delivery/,
        /pending delivery or earlier rings in the Spur\s*queue defer repeats/,
        /exhaust their waiting window/,
        /Most notices await recipients/,
        /taskless worker, orchestrator and operator-agent\s*answers end without a live asking session/,
        /Curator and course-check orchestrator\s*questions fall back to operator/,
        /Operator conversations await their project/,
        /Exhaustion alerts the operator/,
        /curator questions move to operator/,
        /except removals and quiet-turn reminders/,
      ],
      keys: ['board inbox'],
    },
    {
      section: 'Course checks and cycle limits',
      topic: 'turns',
      clauses: [
        /If returns keep hitting the same mechanism/,
        /fix the bug class once/,
        /cover its variants with one table test/,
        /remaining edges with no user-visible effect under Risk in the PR description/,
        /Still fix P0\/P1 and user-visible findings in this PR/,
        /defaults to 3/,
        /`courseCheck: 0` disables/,
        /defaults to 10 and\s*takes priority/,
        /Executor returns and external comments \(a changes-requested\s+review is one\) count,\s*as do thread returns/,
        /CI failures, conflicts and drafts alone do not count/,
        /answer\s*resets the course count and reaches the worker as a task comment/,
        /Only the\s*operator can resolve the separate cycle limit and reset its count/,
        /no live\s*session[\s\S]*falls back to the operator/,
        /does not\s*answer keeps the question/,
      ],
      keys: [
        'projects[].columns[].courseCheck',
        'projects[].columns[].courseCheckTo',
        'projects[].columns[].cycleLimit',
        'projects[].spurProjects[].role',
      ],
    },
    {
      section: 'Task history',
      topic: 'history',
      clauses: [
        /oldest first by\s*time/,
        /events at one time keep journal order/,
        /Checks count the required ones, else all but skipped/,
      ],
      keys: ['board task history <task>'],
    },
    {
      section: 'Blocks and escalation',
      topic: 'blocks',
      clauses: [
        /question \(`needs_input`\)/,
        /avoids asking yourself/,
        /curators ask the operator/,
        /`code` block goes to the worker/,
        /`dependency` or `external` block stays with\s*its author's role/,
        /column orchestrator to curator to\s*operator/,
        /other blocks escalate straight to the operator/,
        /Taskless: all roles, operator only/,
        /`board project ask <project> <text> --to operator --key <key>`/,
        /Project `needs_input` blocks get Slack threads except operator-agent asks/,
        /operator: `board inbox`, keyed `board answer`/,
        /Answers reach a current curator session; other roles use the asking session/,
        /`board followup <block> <text>`\s*rings the author like an answer/,
        /the block\s*stays closed, and the column and turn do not change/,
      ],
      keys: [
        'projects[].columns[].orchestrator',
        'projects[].spurProjects[].role',
        'operator.slack',
      ],
    },
    {
      section: 'Slack now',
      topic: 'slack',
      clauses: [
        /curator answers and operator items/,
        /block threads addressed to the operator/,
        /Answer in the existing block thread/,
        /later reply on an answered\s*block is a follow-up, the same as `board followup`/,
      ],
      keys: ['slack.channels.feed', 'slack.channels.orchestrators'],
    },
    {
      section: 'Slack addressing',
      topic: 'slack',
      clauses: [
        /new operator message in\s*`slack.channels.orchestrators` starts a conversation/,
        /leading registered\s*`@shortName` selects that Spur project and is stripped/,
        /absent or unknown\s*leading name[\s\S]*complete text, retaining any\s*unknown prefix/,
        /replies once with the valid prefixes/,
        /Middle mentions or Slack `<@U…>` address nobody/,
        /unknown names cause no lookup\s*error/,
        /operator checks short-name collisions with workspace names/,
        /task key after the prefix attaches/,
        /Replies\s+use\s*`projects\[\]\.spurProjects\[\]\.displayName`\s+and\s+`icon`/,
        /`close` or ✅ in the\s*thread closes it/,
        /`board status` lists it as waiting/,
        /board-wide operator/,
        /top-level ones too,\s*else project name and the icon of the author's role on the block's task/,
        /orchestrator only on its\s*column's task, else curator or worker; `board` for operator/,
      ],
      keys: [
        'projects[].spurProjects[].shortName',
        'spurProjects[].shortName',
        'projects[].spurProjects[].displayName',
        'slack.defaultAddressee',
        'slack.channels.orchestrators',
        'board inbox',
        'board answer',
      ],
    },
    {
      section: 'Operator inbox',
      topic: 'blocks',
      clauses: [
        /operator grant/,
        /listed once/,
        /`attention`[\s\S]*`failure`/,
        /last 24 h[\s\S]*at most 20/,
        /`answeredVia`/,
        /`action`/,
      ],
      keys: ['board inbox operator'],
    },
    {
      section: 'Done follows the ticket',
      topic: 'done',
      clauses: [
        /One linked PR merging does not by itself finish the task/,
        /for GitHub, the Issue must be\s*closed/,
      ],
      keys: ['projects[].tracker.doneStatuses'],
    },
    {
      section: 'Done wrap-up',
      topic: 'done',
      clauses: [
        /opens one wrap-up turn \(`done: wrap up`\)/,
        /closes like any turn \(submit, the task leaving Done, archive\), and\s+also when its holder session ends/,
        /`turn_closed` outcome `moved`/,
        /holder's end raises no stall block on\s+it/,
      ],
      keys: ['projects[].columns[].orchestrator'],
    },
    {
      section: 'Browser access',
      topic: 'web',
      clauses: [
        /second loopback listener serves browser\s*assets/,
        /Only `comment.add`, `block.answer`, `block.followup` and `item.close` are\s+enabled writes/,
        /a failed bind does not stop the agent API/,
      ],
      keys: ['web.port', 'web.publicOrigin'],
    },
    {
      section: 'Web shell',
      topic: 'web',
      clauses: [
        /streams `GET \/v1\/events` as server-sent events/,
        /show offline after five failed\s*attempts/,
      ],
      keys: ['block.answer', 'comment.add'],
    },
  ])('pins the operational contract in $section', ({ section, topic, clauses, keys }) => {
    const howBoardWorks = readFileSync(
      new URL(`../../../docs/how-board-works-${topic}.md`, import.meta.url),
      'utf8',
    );
    const heading = `## ${section}\n`;
    const start = howBoardWorks.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = howBoardWorks.indexOf('\n## ', start + heading.length);
    const body = howBoardWorks.slice(start + heading.length, end < 0 ? undefined : end);
    for (const clause of clauses) expect(body).toMatch(clause);
    for (const key of keys) expect(body).toContain(`\`${key}\``);
  });

  it('names checksGate among the config get fields', () => {
    const index = readFileSync(
      new URL('../../../docs/how-board-works.md', import.meta.url),
      'utf8',
    );
    const start = index.indexOf('Read effective project configuration');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = index.indexOf('\n\n', start);
    expect(index.slice(start, end < 0 ? undefined : end)).toContain("each project's `checksGate`");
  });

  it('lists every item kind in the operator inbox table', () => {
    const guide = readFileSync(
      new URL('../../../docs/how-board-works-inbox.md', import.meta.url),
      'utf8',
    );
    const start = guide.indexOf('## Item kinds\n');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = guide.indexOf('\n## ', start + 1);
    const section = guide.slice(start, end < 0 ? undefined : end);
    const rows = [...section.matchAll(/^\|\s*`([a-z_]+)`(?:\s+`([a-z-]+:)`)?\s*\|(.*)$/gm)].map(
      (match) => ({
        kind: match[1] ?? '',
        prefix: match[2],
        cells: ['', ...(match[3] ?? '').split('|').slice(0, -1)].map((cell) => cell.trim()),
      }),
    );
    const prefixes = [
      'source:',
      'default-branch:',
      'pr-outcome:',
      'lookup:',
      'operator-block:',
      'block:',
      'filter:',
      'health:',
    ];
    expect([...new Set(rows.map((row) => row.kind))].sort()).toEqual([...ITEM_KINDS].sort());
    for (const kind of ITEM_KINDS) {
      const plain = rows.filter((row) => row.kind === kind && row.prefix === undefined);
      expect(plain, kind).toHaveLength(1);
    }
    expect(
      rows
        .filter((row) => row.prefix !== undefined)
        .map((row) => `${row.kind} ${row.prefix ?? ''}`),
    ).toEqual(prefixes.map((prefix) => `board_observation ${prefix}`));
    for (const row of rows) {
      const label = `${row.kind} ${row.prefix ?? ''}`;
      expect(row.cells, label).toHaveLength(6);
      expect(row.cells[2], label).not.toBe('');
      expect(row.cells[5], label).not.toBe('');
    }
    const action = (kind: string, prefix?: string) =>
      rows.find((row) => row.kind === kind && row.prefix === prefix)?.cells[2] ?? '';
    const hidden = 'not listed: shown as its block';
    expect(action('cycle_limit')).toBe(hidden);
    expect(action('board_observation', 'operator-block:')).toBe(hidden);
    expect(action('anomaly')).toMatch(
      /; listed only when addressed to the curator; otherwise shown as its block$/,
    );
    expect(action('course_check')).toMatch(
      /; listed only when addressed to the curator or orchestrator; otherwise shown as its block$/,
    );
    expect(action('board_observation', 'block:')).toMatch(
      /; listed only when the block is not addressed to you; otherwise shown as its block$/,
    );
    expect(action('turn')).toBe('listed as its `T…` entry');
    expect(action('board_observation', 'filter:')).toContain(
      '`board unlink <task> --pr <pr> --reason <reason>`',
    );
  });
});

function withoutFences(text: string): string {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
}

function headingSlugs(text: string): Set<string> {
  const slugs = new Set<string>();
  for (const match of withoutFences(text).matchAll(/^#{1,6} (.+)$/gm)) {
    const heading = match[1] ?? '';
    if (/[<>]/.test(heading)) {
      throw new Error(`Unsupported HTML or angle brackets in heading: ${heading}`);
    }
    const base = heading
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '')
      .trim()
      .toLowerCase()
      .replace(/\s/g, '-');
    let slug = base;
    let duplicate = 0;
    while (slugs.has(slug)) slug = `${base}-${String(++duplicate)}`;
    slugs.add(slug);
  }
  return slugs;
}

function localLinks(source: string, text: string) {
  const errors: string[] = [];
  let files = 0;
  let fragments = 0;
  const prose = withoutFences(text).replace(/(`+)[\s\S]*?\1/g, '');
  for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const href = match[1] ?? '';
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) continue;
    const [file = '', fragment] = href.split('#');
    const target = file === '' ? source : resolve(dirname(source), decodeURIComponent(file));
    if (file !== '') files++;
    if (!existsSync(target)) {
      errors.push(`Missing file: ${href}`);
    } else if (fragment !== undefined && fragment !== '') {
      fragments++;
      if (!headingSlugs(readFileSync(target, 'utf8')).has(decodeURIComponent(fragment))) {
        errors.push(`Missing fragment: ${href}`);
      }
    }
  }
  return { errors, files, fragments };
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? markdownFiles(path) : path.endsWith('.md') ? [path] : [];
  });
}

describe('documentation local links', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));

  it('resolves local files and heading fragments throughout docs and product skills', () => {
    let fragments = 0;
    for (const tree of ['docs', 'packages/skills']) {
      const paths = markdownFiles(resolve(root, tree));
      expect(paths.length).toBeGreaterThan(0);
      let files = 0;
      for (const path of paths) {
        const result = localLinks(path, readFileSync(path, 'utf8'));
        expect(result.errors, path).toEqual([]);
        files += result.files;
        fragments += result.fragments;
      }
      expect(files, tree).toBeGreaterThan(0);
    }
    expect(fragments).toBeGreaterThan(0);
  });

  it('rejects missing files and fragments', () => {
    const source = resolve(root, 'docs/how-board-works.md');
    expect(localLinks(source, '[missing](missing-guide.md)').errors).toEqual([
      'Missing file: missing-guide.md',
    ]);
    expect(localLinks(source, '[missing](#missing-heading)').errors).toEqual([
      'Missing fragment: #missing-heading',
    ]);
  });

  it.each(['<em>Hello</em>', '<scr<script>ipt>', '<script', 'Hello >'])(
    'rejects unsupported angle-bracket heading syntax: %s',
    (heading) => {
      expect(() => headingSlugs(`# ${heading}`)).toThrow(
        'Unsupported HTML or angle brackets in heading',
      );
    },
  );

  it('handles formatted and duplicate headings, decoded fragments and code exclusions', () => {
    expect([...headingSlugs('# **Hello** `world`\n## Hello world\n## Hello world\n')]).toEqual([
      'hello-world',
      'hello-world-1',
      'hello-world-2',
    ]);
    const source = resolve(root, 'docs/how-board-works.md');
    expect(localLinks(source, '[entry](#how%2Dthe-board-works)').errors).toEqual([]);
    expect(
      localLinks(
        source,
        '`[inline](missing.md)`\n```md\n[fenced](missing.md)\n```\n~~~md\n[tilde](missing.md)\n~~~',
      ).files,
    ).toBe(0);
    expect([...headingSlugs('```md\n# Hidden\n```\n# Visible')]).toEqual(['visible']);
  });
});
