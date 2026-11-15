import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const howBoardWorks = readFileSync(
  new URL('../../../docs/how-board-works.md', import.meta.url),
  'utf8',
);

describe('how the Board works guide', () => {
  it.each([
    {
      section: 'Columns and executors',
      clauses: [
        /`todo`, `ready-for-dev`, `dev`, `review`, `product-review`,\s*`external-review`, `qa`, `ready-to-merge`, `done`/,
        /Each column has one executor/,
        /worker owns the code and branch/,
        /`worker`, `operator` and\s*`curator`/,
        /`orchestrator` project role is planned, not available/,
      ],
      keys: [
        'projects[].columns[].enabled',
        'projects[].columns[].orchestrator',
        'projects[].spurProjects[].role',
      ],
    },
    {
      section: 'Gates and placement',
      clauses: [
        /default is `shadow`/,
        /Gates are cumulative: a column checks its own enabled exit gate and every enabled\s*gate to its left/,
        /turn boundary[\s\S]*leftmost failing column/,
        /Pending CI, unknown mergeability and\s*incomplete comment history are waits/,
        /Downstream handoff waits for settled prerequisites; Dev can still receive a\s*repair turn/,
        /status comment whose last line is a hidden `board-reviewer-progress` or\s*`board-reviewer-unavailable` marker is not external feedback/,
        /mark lasts across visits while its head remains\s*current/,
        /visit submission belongs to one column visit/,
        /new head invalidates internal\s*Review and Product Review marks/,
        /fixed gate rules have no\s*configuration switch/,
      ],
      keys: ['projects[].dispatcher.mode: on', 'projects[].reposWithoutCi'],
    },
    {
      section: 'Turns and delivery',
      clauses: [
        /turn `T<number>`/,
        /Only the acknowledging session may submit\s*or return/,
        /`board inbox ack <entries>`/,
        /`board submit <turn> <sha>`/,
        /`board return <turn> <reason>`/,
        /new head closes taken turns outside Dev; a taken Dev turn survives/,
        /Closed turns receive no further Board sends/,
        /Obsolete queued rings are dropped/,
        /message already accepted by Spur cannot be retracted/,
        /check\s*`board inbox` and act only on a current turn/,
        /shadow mode, use keyed `board submit <task> <sha>`/,
        /answers `pending`:\s*that submit is final/,
        /do not resubmit or raise a block/,
      ],
      keys: ['projects[].dispatcher.submitConfirmMs'],
    },
    {
      section: 'Course checks and cycle limits',
      clauses: [
        /defaults to 3/,
        /`courseCheck: 0` disables/,
        /defaults to 10 and takes priority/,
        /Executor returns, changes requested and external comments count/,
        /CI failures, conflicts and drafts alone do not count/,
        /answer resets the course count and reaches the worker as a task comment/,
        /only the operator can resolve it and reset its count/,
        /no live session[\s\S]*falls back to the\s*operator/,
        /does not answer keeps the question/,
      ],
      keys: [
        'projects[].columns[].courseCheck',
        'projects[].columns[].courseCheckTo',
        'projects[].columns[].cycleLimit',
        'projects[].spurProjects[].role',
      ],
    },
    {
      section: 'Blocks and escalation',
      clauses: [
        /question \(`needs_input`\)/,
        /avoids asking yourself/,
        /`code` block goes to the worker/,
        /`dependency` or `external` block\s*stays with its author's role/,
        /column orchestrator to curator to operator/,
        /other blocks\s*escalate straight to the operator/,
      ],
      keys: [
        'projects[].columns[].orchestrator',
        'projects[].spurProjects[].role',
        'operator.slack',
      ],
    },
    {
      section: 'Slack now',
      clauses: [
        /summaries/,
        /block threads addressed to the operator/,
        /Answer in the existing block thread/,
      ],
      keys: ['slack.channels.feed', 'slack.channels.orchestrators'],
    },
    {
      section: 'Slack addressing',
      clauses: [
        /new operator message in\s*`slack.channels.orchestrators` starts a conversation/,
        /leading registered\s*`@shortName` selects that Spur project and is stripped/,
        /absent or unknown leading name[\s\S]*complete\s*text, retaining any unknown prefix/,
        /replies once with the\s*valid prefixes/,
        /mention in the middle[\s\S]*addresses\s*nobody/,
        /unknown name causes no lookup error/,
        /operator checks short-name\s*collisions with workspace names/,
        /task key right after the prefix attaches/,
        /Replies\s+use\s*`projects\[\]\.spurProjects\[\]\.displayName`\s+and\s+`icon`/,
        /`close` or ✅ in the thread closes it/,
        /`board status` lists it as waiting/,
      ],
      keys: [
        'projects[].spurProjects[].shortName',
        'projects[].spurProjects[].displayName',
        'slack.defaultAddressee',
        'slack.channels.orchestrators',
        'board inbox',
        'board answer',
      ],
    },
    {
      section: 'Done follows the ticket',
      clauses: [
        /One linked PR merging does not by itself finish the task/,
        /for GitHub, the Issue must be closed/,
      ],
      keys: ['projects[].tracker.doneStatuses'],
    },
  ])('pins the operational contract in $section', ({ section, clauses, keys }) => {
    const heading = `## ${section}\n`;
    const start = howBoardWorks.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = howBoardWorks.indexOf('\n## ', start + heading.length);
    const body = howBoardWorks.slice(start + heading.length, end < 0 ? undefined : end);
    for (const clause of clauses) expect(body).toMatch(clause);
    for (const key of keys) expect(body).toContain(`\`${key}\``);
  });
});
