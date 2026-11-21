// The flow task waits in External Review with no external review round past its quietAfterMs, so
// the operator gets one `external-quiet:` item that opens the task.
import { check, entities, flow, items, STEP_MS, submit, take, toReview } from './dispatcher.ts';
import { issueKey, settledUnless } from './helpers.ts';
import type { Board, Scenario } from './index.ts';

const ISSUE = issueKey(1);
const A = 'a'.repeat(40);
/** The least non-zero quietAfterMs. */
const QUIET_MS = 300_000;

/** The flow board with External Review, raising its quiet item after five minutes. */
const withQuietExternalReview = () => {
  const { stand } = flow();
  return {
    stand: {
      ...stand,
      columns: stand.columns.flatMap((column) =>
        column.id === 'ready-to-merge'
          ? [{ id: 'external-review' as const, quietAfterMs: QUIET_MS }, column]
          : [column],
      ),
    },
  };
};

/** The key of the flow task's `external-quiet:` item, if one is raised. */
const quietItem = async (board: Board) =>
  (await items(board)).find(({ key }) => key.startsWith('external-quiet:'))?.key;

export const externalReviewQuiet: Scenario = {
  name: 'external-review-quiet',
  summary: `${ISSUE} waits in External Review six minutes with no external review round; the operator gets an external-quiet: item for it.`,
  config: withQuietExternalReview(),
  async seed(board, fakes) {
    const review = await toReview(board, fakes);
    await take(board, 'orchestrator', review.id);
    await submit(board, 'orchestrator', review.id, A);
    await board.until('External Review', STEP_MS, async () => {
      return (await check(board, { column: 'external-review' })).length === 0;
    });
    await board.shiftClock(QUIET_MS + 60_000);
    await board.poll();
    let key: string | undefined;
    await board.until('external-quiet item', STEP_MS, async () => {
      key = await quietItem(board);
      return key !== undefined;
    });
    return entities(board, { items: { quiet: key ?? '' } });
  },
  async settled({ board }) {
    const problems = await check(board, { column: 'external-review' });
    if ((await quietItem(board)) === undefined) problems.push('no external-quiet: item');
    return settledUnless(problems);
  },
};
