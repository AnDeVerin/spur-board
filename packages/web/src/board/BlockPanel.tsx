import { useState, type ReactNode } from 'react';
import { Banner, Button, KeyValueBox, quiet, SidePanel, Skeleton } from '../ds/index.ts';
import type { BlockState, BoardBlock } from './block-data.ts';
import type { BoardConfig, BoardData } from './data.ts';
import { formatDataTime, shortKey } from './model.ts';
import { TaskBlock } from './TaskBlock.tsx';
import { actorDisplayName } from './task-model.ts';
import styles from './TaskView.module.css';

type Block = BoardBlock['block'];

/** Why no answer form and no Follow up show; undefined when one of them does. */
function readOnlyReason(block: Block): string | undefined {
  if (block.task !== null)
    return `On task ${shortKey(block.task)}. Answer and follow up in its task view.`;
  if (block.addressee !== 'operator')
    return `Addressed to ${block.addressee}. Only blocks addressed to you take an answer or follow-up here.`;
  const question = block.type === 'needs_input';
  if (block.state !== 'open')
    return question && block.outcome === 'done'
      ? undefined
      : `Closed as ${block.outcome ?? 'closed'}. A closed block takes no answer.`;
  return question ? undefined : 'Not a question. Only a question takes an answer here.';
}

/**
 * The block panel `?open=block:<id>` names, over the inbox when a row opened it: who raised the
 * block, to whom and when, then the block and its thread in the task view's block box. Only an
 * operator block without a task takes an answer or follow-up here; any other says why not.
 */
export function BlockPanel({
  block,
  config,
  now,
  offline,
  notice,
  unavailable,
  drafts,
  onClose,
  onRetry,
  answerIntent,
  followUpIntent,
  refreshBlock,
}: {
  block: BlockState;
  config: BoardConfig | undefined;
  now: number;
  offline: boolean;
  /** A board banner the panel repeats, since the board behind it is inert while it is open. */
  notice?: ReactNode;
  unavailable: string | undefined;
  drafts: BoardData['drafts'];
  onClose: () => void;
  onRetry: () => void;
  answerIntent: BoardData['blockAnswerIntent'];
  followUpIntent: BoardData['blockFollowUpIntent'];
  refreshBlock: BoardData['refreshBlock'];
}) {
  // The follow-up was opened: the answer's "Answer sent." line gives way to it.
  const [followed, setFollowed] = useState(false);
  const { value } = block;
  const failed = block.state === 'failed' || block.retrying;
  const name = (actor: string) => actorDisplayName(actor, config);
  const shown = value?.block;
  const reason = shown && readOnlyReason(shown);
  return (
    <SidePanel
      open
      icon="block"
      title={`Block ${block.id}`}
      detail={value?.project}
      onClose={onClose}
    >
      {notice}
      {block.state === 'missing' ? (
        <p className={styles.note}>Block not found.</p>
      ) : (
        <>
          {failed && !(offline && value !== undefined) && (
            <Banner
              variant="error"
              icon="x"
              action={
                <Button busy={block.retrying} onClick={onRetry}>
                  {block.retrying ? 'Retrying' : 'Retry'}
                </Button>
              }
            >
              Could not load the block.
            </Banner>
          )}
          {value === undefined || shown === undefined ? (
            block.state === 'loading' && <Skeleton />
          ) : (
            <>
              <div className={quiet}>
                <KeyValueBox
                  rows={[
                    { key: 'Raised by', value: name(shown.author) },
                    {
                      key: 'To',
                      value: shown.addressee === 'operator' ? 'you' : shown.addressee,
                    },
                    { key: 'Since', value: formatDataTime(Date.parse(shown.at)) },
                    ...(shown.task === null
                      ? []
                      : [
                          {
                            key: 'Task',
                            value: <span title={shown.task}>{shortKey(shown.task)}</span>,
                          },
                        ]),
                  ]}
                />
              </div>
              <TaskBlock
                block={shown}
                replies={value.comments}
                name={name}
                now={now}
                unavailable={unavailable}
                taskKey={`block:${block.id}`}
                superseded={followed}
                onFollowOpen={() => {
                  setFollowed(true);
                }}
                answerIntent={answerIntent}
                followUpIntent={followUpIntent}
                drafts={drafts}
                refreshTask={refreshBlock}
                defaultExpanded
                readOnly={shown.task !== null || shown.addressee !== 'operator'}
                subject="block"
              />
              {reason !== undefined && <p className={styles.note}>{reason}</p>}
            </>
          )}
        </>
      )}
    </SidePanel>
  );
}
