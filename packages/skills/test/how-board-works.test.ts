import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ITEM_KINDS } from '../../contracts/src/index.ts';

describe('how the Board works guide', () => {
  it('maps every built-in column to its position source, mover and placement command', () => {
    const path = new URL('../../../docs/how-board-works-columns.md', import.meta.url);
    const rows = (readFileSync(path, 'utf8').match(/^\|.+/gm) ?? []).map((row) =>
      row.replace(/^\|\s*|\s*\|$|`/g, '').replace(/\s*\|\s*/g, '|'),
    );
    expect(rows[0]).toBe('Column|Position source|Who moves|Command');
    expect(rows.slice(2).join('\n'))
      .toBe(`todo|New/reopened; manual|Dispatcher/operator|board move <task> todo --reason <text> --key <key>
triage|Manual|Operator|board move <task> triage --reason <text> --key <key>
ready-for-dev|Manual or Project mirror|Operator/mirror|board move <task> ready-for-dev --reason <text> --key <key>
dev|Work start/gate failure/return|Dispatcher/executor/operator|board move <task> dev --correct --reason <text>
review|Gates: internal review|Dispatcher/operator|board move <task> review --correct --reason <text>
product-review|Gates: product review|Dispatcher/operator|board move <task> product-review --correct --reason <text>
external-review|Gates: external approval|Dispatcher/operator|board move <task> external-review --correct --reason <text>
qa|Gates: QA confirmation|Dispatcher/operator|board move <task> qa --correct --reason <text>
ready-to-merge|Gates: merge|Dispatcher/operator|board move <task> ready-to-merge --correct --reason <text>
done|Completion: PR/ticket facts|Dispatcher|None (automatic)`);
  });
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
        /`none` \(Dev: live worker, else operator; Done: worker wrap-up or none; External\s*Review: no turn; others: operator\), `operator`, or project with role\s*`orchestrator` or `curator`/,
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
        /actions: move the task, open an executor turn/,
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
        /Other visit\s*submissions belong to one column visit/,
        /QA submissions\s*also survive returns and corrections to Dev on the same head/,
        /different observed PR head permanently invalidates[\s\S]*even if the head later returns/,
        /correction into QA clears confirmed and pending QA evidence/,
        /with passing upstream gates,\s*this opens a fresh QA turn/,
        /A submit counts only in its own column\. After a submit, an operator Ready to Merge waits for the merge with no new turn/,
        /Retained QA cannot supply Dev's submit\s*requirement/,
        /Taken turns hold until submit, return or a new head/,
        /Gate rules have no switch/,
        /Gate rules have no switch\s*except enabled columns, no-CI, checks gate, resolved threads and review rule/,
        /`projects\[\]\.checksGate` \(default `dev`/,
        /Red\s*checks return the task to Dev from any column, after the submit of a taken turn/,
        /Only right of `dev` a cancelled check counts as running\s*for about two GitHub poll intervals/,
        /Applies after a restart/,
        /`projects\[\]\.columns\[\]\.requireResolvedThreads` \(default: `ready-to-merge` only\)\s*gates that column and those right of it/,
        /an unresolved review thread, outdated\s*or by anyone, returns the task to Dev, whose turn lists each thread link/,
        /worker fixes or answers, then resolves each; reviewers never do/,
        /Dev submit on the same head moves right, keeping marks and approval/,
        /approval's inline notes are threads; it still passes External Review\. Under\s+`github-rules`, GitHub blocking on threads returns the task to\s+Dev from\s+External Review on/,
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
        /new head closes taken turns outside Dev and Done; taken Dev turns and Done\s+wrap-up turns survive pushes, and a wrap-up turn closes when its holder ends or,\s+untaken, no recipient is left/,
        /Closed turns receive no further Board sends/,
        /Obsolete queued rings are dropped/,
        /message already accepted by Spur cannot be retracted/,
        /Check `board inbox` and\s*act only on a current turn/,
        /shadow mode, use keyed `board submit <task> <sha>`/,
        /answer `pending`: that submit is final/,
        /Leaving QA closes its turn; a late submit with a new key gets `turn_closed`/,
        /Confirmation survives upstream revalidation[\s\S]*no second QA submit/,
        /Correction into QA clears even pending QA evidence:\s*with upstream gates passing, a QA orchestrator or operator gets a fresh turn\./,
        /An operator finds turns addressed to it in `board inbox operator`, not `board inbox`\.\s*An operator takes a turn addressed to it, or takes over an open orchestrator\s*turn, taken or not/,
        /Retained QA cannot satisfy Dev: a return to Dev needs the current Dev visit's submit/,
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
        /except removals, quiet-turn reminders and operator rings/,
      ],
      keys: ['board inbox'],
    },
    {
      section: 'Course checks and cycle limits',
      topic: 'turns',
      clauses: [
        /Repeated mechanism: fix its class once, one table test/,
        /Code a finding only if it breaks the task's goal in its target setup or\s+regresses the release, whatever its severity/,
        /else PR Risk with a thread reply,\s+no code/,
        /Unclear scope: `board ask` first/,
        /defaults to 3/,
        /`courseCheck: 0` disables/,
        /defaults to 10 and\s*takes priority/,
        /Executor returns and external comments \(a changes-requested\s+review is one\) count,\s*as do thread returns/,
        /CI failures, conflicts and drafts alone do not count[\s\S]*returns for external comments\s+count toward its `courseCheck` instead, as does each external change request on a new PR head\s+while the task is in Dev, once per head/,
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
        /Answers reach a current curator session; other roles use the asking session\.\s*Without Slack, a block or turn to `operator` rings the operator Spur project's live session/,
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
        /While an operator conversation is open, each\s+operator reply in its thread rings the addressee again; a reply that is only `close` \(or a ✅\s+emoji as the message text\) closes it without ringing\. Later replies are recorded and ring nobody\./,
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
        /holder's end raises no stall block on\s+it\. An untaken wrap-up turn closes the same way when no\s+recipient is left: no live worker is linked to the task \(its worker ended, stopped without an\s+end time, or was unlinked\) and Done has no orchestrator\. That close raises no stall question\s+and waits for a complete Spur read/,
      ],
      keys: ['projects[].columns[].orchestrator'],
    },
    {
      section: 'Browser access',
      topic: 'web',
      clauses: [
        /second loopback listener serves browser\s*assets/,
        /Enabled writes are `comment.add`, `block.answer`, `block.followup`, `item.close` and\s+`task.move`/,
        /The shell moves a task between Backlog parts through `task.move` from the card\s+menu, a drop on another part or the task view\.\s+The Board reorders a task within its column through `task.order` in Manual order: a drag,\s+`Alt\+Up` or `Alt\+Down`, or the card menu\./,
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
      'no-session:',
      'review-rule:',
      'external-quiet:',
    ];
    expect([...new Set(rows.map((row) => row.kind))].sort()).toEqual([...ITEM_KINDS].sort());
    for (const kind of ITEM_KINDS) {
      const plain = rows.filter((row) => row.kind === kind && row.prefix === undefined);
      expect(plain, kind).toHaveLength(1);
    }
    const prefixed = rows.filter((row) => row.prefix !== undefined);
    expect(prefixed.map((row) => `${row.kind} ${row.prefix ?? ''}`)).toEqual(
      prefixes.map((prefix) => `board_observation ${prefix}`),
    );
    for (const row of rows) {
      const label = `${row.kind} ${row.prefix ?? ''}`;
      expect(row.cells, label).toHaveLength(6);
      expect(row.cells[2], label).not.toBe('');
      expect(row.cells[5], label).not.toBe('');
    }
    const action = (kind: string, prefix?: string, cell = 2) =>
      rows.find((row) => row.kind === kind && row.prefix === prefix)?.cells[cell] ?? '';
    expect(action('cycle_limit')).toBe('not listed: shown as its block');
    expect(action('board_observation', 'operator-block:')).toBe('not listed: shown as its block');
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
    expect(action('board_observation', 'review-rule:', 1)).toMatch(/every thread resolved.*to Dev/);
    expect(action('board_observation', 'filter:')).toContain(
      '`board unlink <task> --pr <pr> --reason <reason>`',
    );
  });
});
