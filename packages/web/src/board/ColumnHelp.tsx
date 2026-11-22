import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import {
  Banner,
  focusRing,
  Icon,
  Skeleton,
  StatusDot,
  TabPanel,
  type IconName,
} from '../ds/index.ts';
import { sessionLinkHref } from '../lib/links.ts';
import { age } from './card.ts';
import { open } from './Card.tsx';
import type { BoardColumns, ColumnsState } from './columns-data.ts';
import { frozenDetail, openHref, shortKey, type BoardColumn, type MirrorSource } from './model.ts';
import { conditionWords } from './task-model.ts';
import styles from './ColumnHelp.module.css';

type DescribedProject = BoardColumns['projects'][number];
type DescribedColumn = DescribedProject['columns'][number];
type Session = NonNullable<DescribedColumn['executor']['session']>;

/** The tabs of a column help panel, Who first. */
export type HelpTab = 'who' | 'rules';

/**
 * An inbox no-session row asks to open a column's help on Who: the column of `project`, the task
 * of its oldest waiting turn and that turn's id when the row names it.
 */
export interface HelpRequest {
  project: string;
  column: string;
  task: string;
  turn?: string | undefined;
}

/** The oldest waiting turn the Who tab links, from the inbox row that opened the panel. */
export type OldestTurn = Pick<HelpRequest, 'task' | 'turn'>;

const classes = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

/**
 * The element holding a column head and its help panel. While `open`, focus moving to any element
 * outside it calls `setOpen(false)`: leaving by Tab or Shift+Tab does not close a Popover, and Enter on the
 * next control (the Inbox button, another column's trigger) fires no outside mousedown.
 */
export function useHelpScope(open: boolean, setOpen: (open: boolean) => void) {
  const scope = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const leave = (event: FocusEvent) => {
      if (event.target instanceof Node && !scope.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('focusin', leave);
    return () => {
      document.removeEventListener('focusin', leave);
    };
  }, [open, setOpen]);
  return scope;
}

/**
 * Who moves a task here: a mirrored part is filled from its tracker, any other group part by
 * hand, else the executor kind decides.
 */
export function actorIcon(
  kind: BoardColumn['kind'],
  part: boolean,
  source: BoardColumn['source'],
): IconName {
  if (part && source.kind === 'mirror') return 'mirror';
  if (part || kind === 'operator') return 'person';
  return kind === 'dispatcher' ? 'dispatcher' : 'agent';
}

/** The described project and column of the last good `columns.describe` answer, if it has them. */
export function describedColumn(
  columns: ColumnsState | undefined,
  id: string,
): { project: DescribedProject; column: DescribedColumn } | undefined {
  const project = columns?.value?.projects.find((candidate) => candidate.id === columns.project);
  const column = project?.columns.find((candidate) => candidate.id === id);
  return project && column ? { project, column } : undefined;
}

/** A bound executor of a column, not a group part, with no live session. */
export const noLiveSession = (column: DescribedColumn | undefined, part: boolean) =>
  !part &&
  column !== undefined &&
  column.executor.project !== null &&
  column.executor.session === null;

const minutes = (ms: number) => `${String(Math.round(ms / 60000))} min`;

function Part({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={styles.part}>
      {title !== undefined && <h4 className={styles.title}>{title}</h4>}
      {children}
    </section>
  );
}

/** A session id linking to its Spur page, plain text when there is no Spur UI origin. */
function SessionLink({ session, spurUiOrigin }: { session: Session; spurUiOrigin: string | null }) {
  const href = sessionLinkHref(spurUiOrigin, session.id);
  const content = (
    <>
      <Icon name="term" />
      {session.id}
    </>
  );
  if (href === null) return <span className={styles.session}>{content}</span>;
  return (
    <a
      className={classes(styles.session, focusRing)}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Session ${session.id}, opens in a new tab`}
    >
      {content}
    </a>
  );
}

/**
 * The read state of a mirror: when it last read, after a status word while degraded, or the
 * frozen Banner when it fails.
 */
function MirrorState({
  mirror,
  read,
  now,
}: {
  mirror: MirrorSource;
  read: BoardColumn['read'];
  now: number | undefined;
}) {
  if (mirror.health === 'failing')
    return (
      <Banner variant="warning" icon="pulse" detail={frozenDetail(mirror, { read })}>
        Not readable: frozen
      </Banner>
    );
  const healthy = mirror.health === 'healthy';
  const state =
    mirror.readAt === null ? 'no complete read yet' : `read ${age(mirror.readAt, now)} ago`;
  const word = read?.waitsForBudget === true ? 'waiting for the GitHub rate budget' : 'degraded';
  return (
    <p className={classes(styles.text, styles.live)}>
      <StatusDot tone={healthy ? 'ok' : 'warn'} />
      {healthy ? state : `${word} · ${state}`}
    </p>
  );
}

function WhoHelp({
  column,
  part,
  source,
  read,
  now,
  spurUiOrigin,
}: {
  column: DescribedColumn;
  part: boolean;
  source: BoardColumn['source'];
  read: BoardColumn['read'];
  now: number | undefined;
  spurUiOrigin: string | null;
}) {
  if (part)
    return (
      <Part title="Moves tasks here">
        <p className={styles.text}>
          <b>{column.movedBy.kind}</b>
          {source.kind === 'mirror' && (
            <>
              {' · GitHub Project '}
              <b>{source.name}</b>
              {` · ${source.field}`}
            </>
          )}
        </p>
        {source.kind === 'mirror' && <MirrorState mirror={source} read={read} now={now} />}
        <p className={styles.text}>{column.movedBy.text}</p>
      </Part>
    );
  const { executor, escalation } = column;
  const { chain, silent, noRecipient, quiet } = escalation;
  return (
    <>
      <Part title="Acts here">
        <p className={styles.text}>
          <b>{executor.kind}</b>
          {executor.project !== null && (
            <>
              {' · Spur project '}
              <b>{executor.project}</b>
              {executor.role !== null && ` · role ${executor.role}`}
            </>
          )}
        </p>
        <p className={styles.text}>{executor.text}</p>
        {executor.project !== null &&
          (executor.session === null ? (
            <Banner
              variant="warning"
              icon="pulse"
              detail={`Start a session of ${executor.project}; open turns wait until then.`}
            >
              No live session
            </Banner>
          ) : (
            <p className={classes(styles.text, styles.live)}>
              <StatusDot tone="ok" />
              live session <SessionLink session={executor.session} spurUiOrigin={spurUiOrigin} />
            </p>
          ))}
      </Part>
      {chain.length > 0 && (
        <Part title="Questions go">
          <p className={classes(styles.text, styles.chain)}>
            {chain.map((step, index) => (
              // The chain is shown as the read gives it; a step has no identity besides its place.
              <Fragment key={index}>
                {index > 0 && <span className={styles.arrow}>→</span>}
                <span className={styles.step}>
                  {step.displayName ?? step.role}
                  {step.session !== null && (
                    <SessionLink session={step.session} spurUiOrigin={spurUiOrigin} />
                  )}
                </span>
              </Fragment>
            ))}
          </p>
        </Part>
      )}
      {silent !== null && (
        <Part title="When the executor is silent">
          <p className={styles.text}>
            A reminder after {minutes(silent.remindAfterMs)} of a quiet turn
            {noRecipient !== null &&
              `; with no live session, an item in your inbox after ${minutes(noRecipient.operatorItemAfterMs)}`}
            .
          </p>
        </Part>
      )}
      {quiet !== null && (
        <Part title="When no new external round">
          <p className={styles.text}>
            {quiet.operatorItemAfterMs > 0 ? (
              <>
                An item in your inbox after <b>{minutes(quiet.operatorItemAfterMs)}</b> without a
                new external review round.
              </>
            ) : (
              'Off: no inbox item.'
            )}
          </p>
          <p className={styles.text}>{quiet.text}</p>
        </Part>
      )}
    </>
  );
}

function Conditions({ conditions }: { conditions: DescribedColumn['exit']['conditions'] }) {
  return (
    <ol className={styles.list}>
      {conditions.map((condition) => (
        <li key={condition.id}>
          <span className={styles.label}>{conditionWords(condition.id)}</span>
          <span className={styles.muted}>{condition.text}</span>
        </li>
      ))}
    </ol>
  );
}

function RulesHelp({ project, column }: { project: DescribedProject; column: DescribedColumn }) {
  const { exit, returns, limits } = column;
  const { conditions } = exit;
  const courseCheck =
    limits === null
      ? ''
      : limits.courseCheck > 0
        ? ` After ${String(limits.courseCheck)} returns ${limits.courseCheckTo.displayName ?? limits.courseCheckTo.role} checks the course.`
        : ' No course check.';
  return (
    <>
      {conditions.length === 0 ? (
        <Part>
          <p className={styles.text}>Nothing leaves this column.</p>
        </Part>
      ) : exit.to === null ? (
        <>
          <Part title="Waits here until">
            <Conditions conditions={conditions} />
          </Part>
          <Part title={`Leaves to ${project.completion.to} by the completion route`}>
            <p className={styles.text}>{project.completion.text}</p>
          </Part>
        </>
      ) : (
        <Part title={`Leaves to ${exit.to} when${conditions.length > 1 ? ' all hold' : ''}`}>
          <Conditions conditions={conditions} />
        </Part>
      )}
      {returns.length > 0 && (
        <Part title={limits === null ? 'Returns when any holds' : 'Returns to dev when any holds'}>
          <ul className={styles.list}>
            {returns.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </Part>
      )}
      {limits !== null && returns.length > 0 && (
        <Part title="Limits">
          <p className={styles.text}>
            {limits.cycleLimit} returns, then the task stops for the operator.{courseCheck}
          </p>
        </Part>
      )}
    </>
  );
}

/**
 * The selected tab of a column's help panel, from `columns.describe`: a Skeleton until the read
 * the open waits for settles, an error Banner when it failed or its answer lacks the column.
 */
export function ColumnHelp({
  column,
  part,
  tab,
  tabsId,
  columns,
  now,
  spurUiOrigin,
  oldest,
  onOpen,
}: {
  column: BoardColumn;
  part: boolean;
  tab: HelpTab;
  tabsId: string;
  columns: ColumnsState | undefined;
  /** The time of the last good read: a mirror's read age counts to it. */
  now: number | undefined;
  spurUiOrigin: string | null;
  /** Linked above the Who body, whatever state the read is in. */
  oldest?: OldestTurn | undefined;
  /** A plain click on the oldest turn's link opens its task. */
  onOpen?: ((key: string) => void) | undefined;
}) {
  const help = columns?.help;
  const loading = help === undefined || help === 'loading';
  const described = help === 'ready' ? describedColumn(columns, column.id) : undefined;
  let body: ReactNode;
  if (loading)
    body = (
      <div className={styles.state}>
        <Skeleton widths={[40, 100, 80, 60]} />
      </div>
    );
  else if (described === undefined)
    body = (
      <div className={styles.state}>
        <Banner
          variant="error"
          icon="x"
          detail="Close the panel and open it again to read them again."
        >
          Could not read the column rules.
        </Banner>
      </div>
    );
  else if (tab === 'who')
    body = (
      <WhoHelp
        column={described.column}
        part={part}
        source={column.source}
        read={column.read}
        now={now}
        spurUiOrigin={spurUiOrigin}
      />
    );
  else body = <RulesHelp project={described.project} column={described.column} />;
  return (
    <TabPanel tabsId={tabsId} value={tab}>
      {tab === 'who' && oldest !== undefined && (
        <p className={styles.oldest}>
          <a
            className={focusRing}
            href={openHref(oldest.task)}
            onClick={(event) => {
              open(event, oldest.task, onOpen ?? (() => undefined));
            }}
          >
            Oldest waiting turn {oldest.turn === undefined ? '' : `${oldest.turn} `}on{' '}
            {shortKey(oldest.task)}
          </a>
        </p>
      )}
      <div aria-busy={loading ? true : undefined}>{body}</div>
    </TabPanel>
  );
}
