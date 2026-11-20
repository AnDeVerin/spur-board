// QA submit bases on the Ready to Merge card: the dispatcher flow with a QA column, whose QA
// submit on head A declares `carried` (from A) or `skipped`.
import { randomUUID } from 'node:crypto';
import type { SubmissionBasis } from '@spur-board/contracts';
import { awaitTurn, check, entities, ISSUE, take, toReview } from './dispatcher.ts';
import { settledUnless } from './helpers.ts';
import type { Scenario } from './index.ts';

const A = 'a'.repeat(40);

const REASONS = {
  carried: 'Only docs changed since the tested head.',
  skipped: 'No testable surface: an offline export script.',
} as const;

function qaBasis(basis: Exclude<SubmissionBasis, 'tested'>): Scenario {
  return {
    name: `qa-${basis}`,
    summary: `${ISSUE} passes Dev, Review and QA on head A, QA submitted as ${basis}, and waits in Ready to Merge.`,
    config: {
      stand: {
        columns: [
          { id: 'todo' },
          { id: 'dev' },
          { id: 'review', orchestrator: 'stand-qa' },
          { id: 'qa', orchestrator: 'stand-qa' },
          { id: 'ready-to-merge', orchestrator: 'operator' },
          { id: 'done' },
        ],
        dispatcher: { mode: 'on' },
      },
    },
    async seed(board, fakes) {
      const review = await toReview(board, fakes);
      await take(board, 'orchestrator', review.id);
      await board.call('orchestrator', 'task.submit', { turn: review.id, sha: A }, randomUUID());
      const qa = await awaitTurn(board, 'orchestrator', 'qa: no_submit_on_head');
      await take(board, 'orchestrator', qa.id);
      await board.call(
        'orchestrator',
        'task.submit',
        {
          turn: qa.id,
          sha: A,
          basis,
          ...(basis === 'carried' ? { from: A } : {}),
          reason: REASONS[basis],
        },
        randomUUID(),
      );
      return entities(board);
    },
    async settled({ board }) {
      const problems = await check(board, { column: 'ready-to-merge' });
      const { tasks } = await board.call('operator', 'status.get', { project: 'stand' });
      const qa = tasks.find(({ key }) => key === ISSUE)?.qaSubmission;
      if (
        qa?.basis !== basis ||
        qa.reason !== REASONS[basis] ||
        qa.from !== (basis === 'carried' ? A : null)
      )
        problems.push(`QA submission ${JSON.stringify(qa)}, not ${basis}`);
      return settledUnless(problems);
    },
  };
}

export const qaCarried = qaBasis('carried');
export const qaSkipped = qaBasis('skipped');
