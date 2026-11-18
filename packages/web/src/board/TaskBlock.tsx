import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Chip, focusRing, Icon, LineClamp, quiet, TextToggle } from '../ds/index.ts';
import type { BoardData, BoardTask } from './data.ts';
import { TaskWrite } from './TaskWrite.tsx';
import { age } from './task-model.ts';
import styles from './TaskView.module.css';

type Block = BoardTask['blocks'][number];
type Reply = BoardTask['comments'][number];

/**
 * One block of the task view in its own box with a header band. An open block is always whole.
 * A closed block starts folded to its first lines when something is hidden: a longer reason,
 * replies or an outcome line. A writer that holds a draft or an open form keeps it whole, and
 * it stays unfolded after the hold ends. Both writers stay mounted in every state, so a draft
 * and its intent key survive folding.
 */
export function TaskBlock({
  block,
  replies,
  name,
  now,
  unavailable,
  taskKey,
  superseded,
  onFollowOpen,
  answerIntent,
  followUpIntent,
  drafts,
  refreshTask,
}: {
  block: Block;
  replies: readonly Reply[];
  name: (actor: string) => string;
  now: number;
  unavailable: string | undefined;
  taskKey: string;
  superseded: boolean;
  onFollowOpen: () => void;
  answerIntent: BoardData['answerIntent'];
  followUpIntent: BoardData['followUpIntent'];
  drafts: BoardData['drafts'];
  refreshTask: BoardData['refreshTask'];
}) {
  const open = block.state === 'open';
  const question = block.type === 'needs_input';
  const mine = open && block.addressee === 'operator';
  const answered = question && block.state === 'unblocked' && block.outcome === 'done';
  const outcomeLine = !answered && Boolean(block.outcomeReason);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(true);
  // The latest measurement, written before it reaches state.
  const overflowsNow = useRef(true);
  const [answerHeld, setAnswerHeld] = useState(false);
  const [followHeld, setFollowHeld] = useState(false);
  const held = answerHeld || followHeld;
  const foldable = !open && !held && (overflows || replies.length > 0 || outcomeLine);
  const folded = !expanded;
  const hidden = folded && foldable;
  const regionId = useId();
  const article = useRef<HTMLElement>(null);
  const band = useRef<HTMLElement>(null);
  const setBand = (node: HTMLElement | null) => {
    band.current = node;
  };
  const refocus = useRef(false);
  const [fallbackFocus, setFallbackFocus] = useState(false);
  // After a fold change, focus goes to the control that folds the block again, once a fresh
  // measurement has settled whether the band is still a button; else to the article.
  useLayoutEffect(() => {
    if (!refocus.current || overflowsNow.current !== overflows) return;
    refocus.current = false;
    if (band.current instanceof HTMLButtonElement) band.current.focus();
    else setFallbackFocus(true);
  });
  useLayoutEffect(() => {
    if (fallbackFocus) article.current?.focus();
  }, [fallbackFocus]);
  const toggle = (next: boolean) => {
    refocus.current = true;
    setExpanded(next);
  };
  const hold = (set: (held: boolean) => void) => (next: boolean) => {
    set(next);
    if (next) setExpanded(true);
  };
  const metadata = (author: string, at: string) => `${name(author)} · ${age(at, now)}`;
  const status = open
    ? 'open'
    : answered
      ? `answered${block.answeredVia ? ` via ${block.answeredVia === 'slack' ? 'Slack' : block.answeredVia}` : ''}`
      : (block.outcome ?? 'closed');
  const head = (
    <>
      {foldable && (
        <span className={styles.caret}>
          <Icon name="caret" />
        </span>
      )}
      <strong className={styles.id}>{block.id}</strong>
      <span>{metadata(block.author, block.at)}</span>
      <span>→ {block.addressee === 'operator' ? 'you' : block.addressee}</span>
      <span className={styles.status}>
        <Chip tone={mine ? 'you' : open ? 'warn' : answered ? 'ready' : 'default'}>
          {answered && <Icon name="check" />}
          {status}
        </Chip>
      </span>
    </>
  );
  const hiddenParts = [
    replies.length > 0
      ? `${String(replies.length)} ${replies.length === 1 ? 'reply' : 'replies'}`
      : '',
    outcomeLine ? 'outcome' : '',
  ].filter(Boolean);
  const tone = open ? (mine ? styles.mine : styles.agent) : undefined;
  return (
    <article
      ref={article}
      className={[quiet, styles.block, tone, focusRing].filter(Boolean).join(' ')}
      tabIndex={fallbackFocus ? -1 : undefined}
      onBlur={(event) => {
        if (event.target === event.currentTarget) setFallbackFocus(false);
      }}
    >
      {foldable ? (
        <button
          ref={setBand}
          type="button"
          className={`${styles.band ?? ''} ${focusRing}`}
          aria-expanded={!folded}
          aria-controls={regionId}
          title={folded ? `Show all of ${block.id}` : `Collapse ${block.id}`}
          onClick={() => {
            toggle(folded);
          }}
        >
          {head}
        </button>
      ) : (
        <div ref={setBand} className={styles.band}>
          {head}
        </div>
      )}
      {/* Show all and the band button are the keyboard paths; this click is a mouse shortcut. */}
      <div
        className={[styles.body, hidden ? styles.peek : undefined].filter(Boolean).join(' ')}
        onClick={
          hidden
            ? () => {
                if (document.getSelection()?.toString()) return;
                toggle(true);
              }
            : undefined
        }
      >
        {open || held || expanded ? (
          <p className={styles.text}>{block.reason}</p>
        ) : (
          <LineClamp
            onOverflowChange={(next) => {
              overflowsNow.current = next;
              setOverflows(next);
            }}
          >
            {block.reason}
          </LineClamp>
        )}
        {hidden && (
          <TextToggle
            expanded={false}
            controls={regionId}
            onClick={() => {
              toggle(true);
            }}
          >
            {['… Show all', ...hiddenParts].join(' · ')}
          </TextToggle>
        )}
        <div id={regionId} className={styles.rest} hidden={hidden}>
          {replies.map((reply) => (
            <div key={reply.id} className={styles.reply}>
              <div className={styles.metadata}>
                {reply.id} · {metadata(reply.author, reply.at)}
              </div>
              <p className={styles.text}>{reply.text}</p>
            </div>
          ))}
          {outcomeLine && <p className={styles.text}>{block.outcomeReason}</p>}
          <TaskWrite
            eligible={mine && question}
            label={`Answer ${block.id}`}
            kind="answer"
            superseded={superseded}
            unavailable={unavailable}
            createIntent={(text) => answerIntent(taskKey, block.id, text)}
            refreshTask={refreshTask}
            drafts={drafts}
            draftId={JSON.stringify(['answer', taskKey, block.id])}
            onHeldChange={hold(setAnswerHeld)}
          />
          {(answered || foldable) && (
            <div className={styles.foot}>
              {answered && (
                <TaskWrite
                  label={`Follow-up on ${block.id}`}
                  kind="followup"
                  unavailable={unavailable}
                  onOpen={onFollowOpen}
                  createIntent={(text) => followUpIntent(taskKey, block.id, text)}
                  refreshTask={refreshTask}
                  drafts={drafts}
                  draftId={JSON.stringify(['followup', taskKey, block.id])}
                  onHeldChange={hold(setFollowHeld)}
                />
              )}
              {foldable && !folded && (
                <TextToggle
                  expanded
                  caret
                  controls={regionId}
                  onClick={() => {
                    toggle(false);
                  }}
                >
                  Collapse {block.id}
                </TextToggle>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
