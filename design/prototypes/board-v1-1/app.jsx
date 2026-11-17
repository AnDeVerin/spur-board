// Board V1.1 prototype: three refinements of the shipped board.
//   1. Sort inside a column by key or by the time the task entered the column.
//   2. Task view blocks: a header band, closed blocks folded to three lines.
//   3. History: runs of alike journal rows fold into one row.
// The screen parts the app already has (card, column, task view shell) are simplified stand-ins;
// the proposed parts carry a `proposed-*` class and a `data-proposed` attribute.
const { useState, useRef, useLayoutEffect, Fragment } = DS.React;

const params = new URLSearchParams(location.search);
const pick = (name, allowed) => {
  const value = params.get(name);
  return allowed.includes(value) ? value : allowed[0];
};
const initialState = pick('state', ['board', 'task', 'history']);
const initialTheme = pick('theme', ['dark', 'light']);
const initialSort = pick('sort', ['entered-asc', 'entered-desc', 'key-asc', 'key-desc']);
const sortPlace = pick('sortui', ['column', 'board']);
const groupMode = pick('group', ['text', 'kind']);
const headStyle = pick('head', ['band', 'plain']);
const marks = pick('marks', ['on', 'off']);
const initialTokens = pick('tokens', ['proposed', 'now']);
const initialColor = pick('color', ['on', 'off']);
/** Runs shorter than this stay as separate rows. */
const MIN_RUN = 3;

function applyTheme(preference) {
  const light =
    preference === 'light' ||
    (preference === 'auto' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}

const shortKey = (key) => /#\d+$/.exec(key)?.[0] ?? key;
const pad = (value) => String(value).padStart(2, '0');
function clock(iso) {
  const date = new Date(iso);
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
function day(iso) {
  const date = new Date(iso);
  return `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCFullYear() % 100)}`;
}
function age(iso, now) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(minutes / 1440)}d`;
}
const actorName = (actor) =>
  actor === 'operator'
    ? 'you'
    : actor.startsWith('agent:')
      ? actor.slice(6).replace('/', ' / ')
      : actor;

function Proposed() {
  return <span className="proposed-label">proposed</span>;
}

// ---- 1. Column sort -------------------------------------------------------------------------

/** One letter per field: K is the key, T the time in the column; the tooltip spells it out. */
const SORT_FIELDS = { entered: 'T', key: 'K' };
const SORT_HINT = {
  'entered-asc': 'Longest in the column first',
  'entered-desc': 'Newest in the column first',
  'key-asc': 'Lowest key first',
  'key-desc': 'Highest key first',
};
const byKey = (a, b) => a.key.localeCompare(b.key, 'en', { numeric: true });
const byEntered = (a, b) => Date.parse(a.columnEnteredAt) - Date.parse(b.columnEnteredAt);
function sortRows(rows, sort) {
  const [field, direction] = sort.split('-');
  const sorted = [...rows].sort(field === 'key' ? byKey : byEntered);
  return direction === 'asc' ? sorted : sorted.reverse();
}

/** Proposed: two quiet buttons, the field and the direction. */
function SortControl({ sort, onChange, label, first }) {
  const [field, direction] = sort.split('-');
  return (
    <span className="proposed-sort" data-proposed="sort" role="group" aria-label={label}>
      {first && <Proposed />}
      <button
        type="button"
        className={`proposed-sort-button ${DS.focusRing}`}
        aria-label={`Sorted by ${field === 'key' ? 'key' : 'time in the column'}`}
        title={
          field === 'key'
            ? 'K: sorted by key. Click for T, time in the column.'
            : 'T: sorted by time in the column. Click for K, key.'
        }
        onClick={() => onChange(`${field === 'key' ? 'entered' : 'key'}-${direction}`)}
      >
        {SORT_FIELDS[field]}
      </button>
      <button
        type="button"
        className={`proposed-sort-button ${DS.focusRing}`}
        aria-label={SORT_HINT[sort]}
        title={`${SORT_HINT[sort]}. Click to reverse.`}
        onClick={() => onChange(`${field}-${direction === 'asc' ? 'desc' : 'asc'}`)}
      >
        {direction === 'asc' ? '↑' : '↓'}
      </button>
    </span>
  );
}

/** The four PR cells as the app computes them: checks, merge, threads, reviews. */
function prCells(pr) {
  const { checks, threads, reviewsOnHead: reviews } = pr;
  const total = checks.pass + checks.fail + checks.pending;
  return [
    {
      icon: 'check',
      text: `${checks.pass}/${total}`,
      tone: checks.fail > 0 ? 'bad' : checks.pending > 0 ? 'pend' : 'ok',
    },
    { icon: 'merge', text: '', tone: pr.mergeable ? 'ok' : 'bad' },
    {
      icon: 'bubble',
      text: threads.total === 0 ? '–' : `${threads.unresolved}/${threads.total}`,
      tone: threads.total === 0 ? 'none' : threads.unresolved > 0 ? 'pend' : 'ok',
    },
    {
      icon: 'person',
      text:
        reviews.changesRequested.length > 0
          ? String(reviews.changesRequested.length)
          : reviews.approved.length > 0
            ? String(reviews.approved.length)
            : '–',
      tone:
        reviews.changesRequested.length > 0 ? 'bad' : reviews.approved.length > 0 ? 'ok' : 'none',
    },
  ];
}

/**
 * A stand-in for the app card with its real parts: key, quick links, title, PR cells, markers and
 * the turn line. Proposed here is only the colour (`:root[data-color='on']` in proto.css) and
 * the time in the column beside the key.
 */
function Card({ row, now, onOpen }) {
  const turn = row.turn;
  const kind =
    turn === null ? 'none' : turn.addressee === 'operator' ? 'you' : turn.taken ? 'agent' : 'wait';
  const pr = row.prSummary?.[0];
  const quick = [
    'ticket',
    ...(row.links.prs.length > 0 ? ['pr'] : []),
    ...(row.links.sessions.length > 0 ? ['term'] : []),
  ];
  return (
    <div className={`card-wrap ${DS.quiet}`} data-turn={kind}>
      <a
        className={`card ${DS.focusRing}`}
        href="?state=task"
        onClick={(event) => {
          event.preventDefault();
          onOpen();
        }}
      >
        <span className="card-key-row">
          <b className="card-key">{shortKey(row.key)}</b>
          <span className="card-entered" title="Time in this column">
            {age(row.columnEnteredAt, now)}
          </span>
        </span>
        <span className="card-title">{row.ticket.title}</span>
        {pr ? (
          <span className="card-cells">
            {prCells(pr).map((cell) => (
              <span key={cell.icon} className="card-cell" data-tone={cell.tone}>
                <DS.Icon name={cell.icon} />
                {cell.text}
              </span>
            ))}
          </span>
        ) : (
          kind !== 'none' && <span className="card-placeholder">no PR yet</span>
        )}
        {(row.openBlocks > 0 || row.returned) && (
          <span className="card-markers">
            {row.openBlocks > 0 && (
              <span className="card-marker" data-marker="block">
                <DS.Chip>
                  <DS.Icon name="block" />
                  {row.openBlocks} {row.openBlocks === 1 ? 'block' : 'blocks'}
                </DS.Chip>
              </span>
            )}
            {row.returned && (
              <DS.Chip tone="warn">
                <DS.Icon name="back" />
                returned
              </DS.Chip>
            )}
          </span>
        )}
        {turn && (
          <span className="card-turn">
            <DS.StatusDot tone={kind === 'agent' ? 'working' : 'warn'} hollow={kind === 'wait'} />
            <span className="card-who">
              {turn.id}{' '}
              {kind === 'you' ? (
                <b>your turn</b>
              ) : (
                <Fragment>
                  {turn.addressee.split(':')[0]}{' '}
                  {turn.taken && <b>{turn.taken.by.split('/')[1]}</b>}
                </Fragment>
              )}
            </span>
            <span className="card-age" data-kind={kind}>
              {turn.taken ? 'taken' : kind === 'you' ? 'open' : 'not taken'} ·{' '}
              {age(turn.taken?.at ?? turn.at, now)}
            </span>
          </span>
        )}
      </a>
      <span className="card-links">
        {quick.map((icon) => (
          <span key={icon} className="card-link">
            <DS.Icon name={icon} />
          </span>
        ))}
      </span>
    </div>
  );
}

function Column({ column, rows, sort, onSort, now, onOpen, first }) {
  const executor = column.executor.name
    ? `${column.executor.kind} ${column.executor.name}`
    : column.executor.kind;
  if (rows.length === 0)
    return (
      <section className={`spine ${DS.quiet}`} title={`${column.id}: empty · ${executor}`}>
        <span className="column-count">0</span>
        <h2 className="column-label spine-name">{column.id}</h2>
      </section>
    );
  const done = column.id === 'done';
  return (
    <section className="column">
      <div className={`column-head ${DS.quiet}`}>
        <div className="column-name">
          <h2 className="column-label">{column.id}</h2>
          <span className="column-count">{rows.length}</span>
        </div>
        <div className="column-sub">
          <span className="column-exec">{executor}</span>
          {sortPlace === 'column' && (
            <SortControl sort={sort} onChange={onSort} label={`Sort ${column.id}`} first={first} />
          )}
        </div>
      </div>
      <div className={done ? `column-body done ${DS.quiet}` : 'column-body'}>
        {sortRows(rows, sort).map((row) =>
          done ? (
            <a
              key={row.key}
              className={`done-row ${DS.focusRing}`}
              href="?state=task"
              onClick={(event) => {
                event.preventDefault();
                onOpen();
              }}
            >
              <span className="done-check">
                <DS.Icon name="check" />
              </span>
              <b className="done-key">{shortKey(row.key)}</b>
              <span className="done-title">{row.ticket.title}</span>
              <span className="card-entered">{age(row.columnEnteredAt, now)}</span>
            </a>
          ) : (
            <Card key={row.key} row={row} now={now} onOpen={onOpen} />
          ),
        )}
      </div>
    </section>
  );
}

function BoardArea({ fixture, now, onOpen }) {
  const project = fixture['config.get'].projects[0];
  const [sorts, setSorts] = useState({});
  const [boardSort, setBoardSort] = useState(initialSort);
  const rows = fixture['status.get'].tasks;
  const firstFilled = project.columns.find((column) =>
    rows.some((row) => row.column === column.id),
  );
  return (
    <Fragment>
      <div className="board-top">
        <DS.Logo />
        <span className="board-project">{project.id}</span>
        {sortPlace === 'board' && (
          <span className="board-sort">
            <span className="board-sort-label">sort</span>
            <SortControl sort={boardSort} onChange={setBoardSort} label="Sort columns" first />
          </span>
        )}
      </div>
      <main className="board-main">
        {project.columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            rows={rows.filter((row) => row.column === column.id)}
            sort={sortPlace === 'board' ? boardSort : (sorts[column.id] ?? initialSort)}
            onSort={(value) => setSorts({ ...sorts, [column.id]: value })}
            now={now}
            onOpen={onOpen}
            first={column === firstFilled}
          />
        ))}
      </main>
    </Fragment>
  );
}

// ---- 2. Blocks ------------------------------------------------------------------------------

function blockStatus(block) {
  if (block.state === 'open') return 'open';
  if (block.type === 'needs_input' && block.outcome === 'done')
    return `answered${block.answeredVia ? ` via ${block.answeredVia === 'slack' ? 'Slack' : block.answeredVia}` : ''}`;
  return block.outcome ?? 'closed';
}

/**
 * Proposed. An open block is always shown whole and has no fold control. A closed block starts
 * folded to three lines of its reason; a click on the folded text or on "Show all" unfolds it,
 * the header caret and the Collapse button at its end fold it again. A closed block whose
 * whole content fits the fold has no control at all.
 */
function Block({ block, replies, now, first }) {
  const open = block.state === 'open';
  const mine = open && block.addressee === 'operator';
  const answered = block.type === 'needs_input' && block.outcome === 'done';
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(true);
  const peek = useRef(null);
  const [answer, setAnswer] = useState('');
  const extra = replies.length > 0 || Boolean(block.outcomeReason);
  const shown = open || expanded;
  useLayoutEffect(() => {
    const node = peek.current;
    if (node) setOverflows(node.scrollHeight > node.clientHeight + 1);
  }, [shown]);
  const foldable = !open && (overflows || extra || expanded);
  const hidden = [
    replies.length > 0 ? `${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}` : '',
    block.outcomeReason ? 'outcome' : '',
  ].filter(Boolean);
  const head = (
    <Fragment>
      {foldable && (
        <span className="proposed-block-caret" data-expanded={expanded ? '' : undefined}>
          <DS.Icon name="caret" />
        </span>
      )}
      <strong className="proposed-block-id">{block.id}</strong>
      <span>
        {actorName(block.author)} · {age(block.at, now)}
      </span>
      <span>→ {block.addressee === 'operator' ? 'you' : block.addressee}</span>
      <span className="proposed-block-status" data-answered={answered ? '' : undefined}>
        <DS.Chip tone={mine ? 'you' : open ? 'warn' : 'default'}>
          {answered && <DS.Icon name="check" />}
          {blockStatus(block)}
        </DS.Chip>
      </span>
    </Fragment>
  );
  return (
    <article
      className={`proposed-block ${DS.quiet}`}
      data-proposed="block"
      data-head={headStyle}
      data-state={mine ? 'mine' : open ? 'open' : 'closed'}
    >
      {first && <Proposed />}
      {foldable ? (
        <button
          type="button"
          className={`proposed-block-head ${DS.focusRing}`}
          aria-expanded={expanded}
          title={expanded ? `Collapse ${block.id}` : `Show all of ${block.id}`}
          onClick={() => setExpanded(!expanded)}
        >
          {head}
        </button>
      ) : (
        <div className="proposed-block-head">{head}</div>
      )}
      {shown ? (
        <div className="proposed-block-body">
          <p className="block-text">{block.reason}</p>
          {replies.map((reply) => (
            <div key={reply.id} className="block-reply">
              <div className="block-meta">
                {reply.id} · {actorName(reply.author)} · {age(reply.at, now)}
              </div>
              <p className="block-text">{reply.text}</p>
            </div>
          ))}
          {!answered && block.outcomeReason && <p className="block-text">{block.outcomeReason}</p>}
          {mine && block.type === 'needs_input' && (
            <div className="block-form">
              <DS.TextArea value={answer} onChange={setAnswer} label={`Answer ${block.id}`} />
              <DS.Button variant="primary" disabled={answer.trim() === ''}>
                Send answer
              </DS.Button>
            </div>
          )}
          {(answered || foldable) && (
            <div className="proposed-block-foot">
              {answered && <DS.Button>Follow up</DS.Button>}
              {foldable && (
                <button
                  type="button"
                  className={`proposed-fold ${DS.focusRing}`}
                  onClick={() => setExpanded(false)}
                >
                  <span className="proposed-fold-caret">
                    <DS.Icon name="caret" />
                  </span>
                  Collapse {block.id}
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        // The folded text is not a button, so it stays selectable; a click that ends a text
        // selection does not unfold.
        <div
          className="proposed-block-body proposed-block-peek"
          data-foldable={foldable ? '' : undefined}
          onClick={() => {
            if (foldable && String(getSelection()) === '') setExpanded(true);
          }}
        >
          <p ref={peek} className="block-text proposed-clamp">
            {block.reason}
          </p>
          {foldable && (
            <button
              type="button"
              className={`proposed-fold ${DS.focusRing}`}
              onClick={(event) => {
                event.stopPropagation();
                setExpanded(true);
              }}
            >
              … Show all{hidden.length > 0 ? ` · ${hidden.join(' · ')}` : ''}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function NowTab({ value, now }) {
  const blocks = [...value.blocks].sort(
    (a, b) => Number(b.state === 'open') - Number(a.state === 'open'),
  );
  const comments = value.comments.filter((comment) => comment.block === null);
  const openCount = blocks.filter((block) => block.state === 'open').length;
  const [comment, setComment] = useState('');
  return (
    <Fragment>
      <div className="task-top">
        <h2 className="task-title">{value.title}</h2>
        <div className="task-links">
          {value.links.map((link) => (
            // Stand-in for the app's link chips; proposed is the tint by kind.
            <span key={link.ref} className="task-link" data-kind={link.kind}>
              <DS.Icon
                name={link.kind === 'pr' ? 'pr' : link.kind === 'ticket' ? 'ticket' : 'term'}
              />
              {link.kind === 'pr'
                ? `PR ${shortKey(link.ref)}`
                : link.kind === 'ticket'
                  ? `ticket ${shortKey(link.ref)}`
                  : `session ${link.ref}`}
            </span>
          ))}
        </div>
      </div>
      <div className="proposed-sections" data-proposed="section-title">
        <DS.CollapsibleSection
          title="Why it is here"
          summary={`1 failed · ${openCount} open blocks`}
        >
          <DS.KeyValueBox rows={value.why.rows} />
        </DS.CollapsibleSection>
        <DS.CollapsibleSection title="Blocks" count={blocks.length} summary={`${openCount} open`}>
          <div className="proposed-blocks">
            {blocks.map((block, index) => (
              <Block
                key={block.id}
                block={block}
                replies={value.comments.filter((entry) => entry.block === block.id)}
                now={now}
                first={index === 0}
              />
            ))}
          </div>
        </DS.CollapsibleSection>
        <DS.CollapsibleSection title="Comments" count={comments.length}>
          <div className="items">
            {comments.map((entry) => (
              <article key={entry.id} className={`item ${DS.quiet}`}>
                <div className="block-meta">
                  {entry.id} · {actorName(entry.author)} · {age(entry.at, now)}
                </div>
                <p className="block-text">{entry.text}</p>
              </article>
            ))}
            <div className="item block-form">
              <DS.TextArea value={comment} onChange={setComment} label="Comment" />
              <DS.Button disabled={comment.trim() === ''}>Add comment</DS.Button>
            </div>
          </div>
        </DS.CollapsibleSection>
      </div>
    </Fragment>
  );
}

// ---- 3. History -----------------------------------------------------------------------------

/**
 * Rows newest first, then runs: neighbours that are alike. `text` mode (default) calls two rows
 * alike when kind, actor, channel and summary are equal; `kind` mode ignores the summary. A run
 * of MIN_RUN or more rows becomes a group whose id is the journal position of its oldest row, so
 * a group keeps its fold state when a newer row joins it.
 */
function historyRuns(events) {
  const rows = events.map((event, index) => ({ ...event, key: index })).reverse();
  const alike = (a, b) =>
    a.kind === b.kind &&
    a.actor === b.actor &&
    a.via === b.via &&
    (groupMode === 'kind' || a.summary === b.summary);
  const runs = [];
  for (const row of rows) {
    const last = runs.at(-1);
    if (last && alike(last.rows[0], row)) last.rows.push(row);
    else runs.push({ rows: [row] });
  }
  return runs.flatMap((run) =>
    run.rows.length >= MIN_RUN
      ? [{ id: run.rows.at(-1).key, rows: run.rows }]
      : run.rows.map((row) => ({ id: row.key, rows: [row] })),
  );
}

function HistoryRow({ row, lead, group, expanded, onToggle, first }) {
  const actor = row.via ? `${actorName(row.actor)} (${row.via})` : actorName(row.actor);
  const oldest = group?.rows.at(-1);
  const since =
    oldest === undefined
      ? ''
      : day(oldest.at) === day(row.at)
        ? clock(oldest.at)
        : `${clock(oldest.at)} ${day(oldest.at)}`;
  return (
    <tr
      className={`${DS.quiet} ${group ? 'proposed-run' : ''}`}
      data-proposed={group ? 'history-run' : undefined}
      data-run={group ? (lead ? (expanded ? 'lead-open' : 'folded') : 'member') : undefined}
    >
      <td className="history-when">
        {clock(row.at)} {day(row.at)}
      </td>
      <td className="history-what">
        {row.summary} · <span className="history-actor">{actor}</span>
        {group && lead && (
          <Fragment>
            {' '}
            <button
              type="button"
              className={`proposed-run-toggle ${DS.focusRing}`}
              aria-expanded={expanded}
              title={
                expanded
                  ? `Fold ${group.rows.length} rows into one`
                  : `Show ${group.rows.length - 1} more rows like this one`
              }
              onClick={onToggle}
            >
              <span className="proposed-run-caret" data-expanded={expanded ? '' : undefined}>
                <DS.Icon name="caret" />
              </span>
              {expanded ? `${group.rows.length} rows` : `+${group.rows.length - 1}`}
            </button>
            {!expanded && <span className="proposed-run-since"> since {since}</span>}
            {first && <Proposed />}
          </Fragment>
        )}
      </td>
      <td className="history-kind">{row.kind}</td>
    </tr>
  );
}

function HistoryTab({ events }) {
  const [open, setOpen] = useState(() => new Set());
  const runs = historyRuns(events);
  const firstGroup = runs.find((run) => run.rows.length > 1);
  return (
    <table className="history" aria-label="Task history">
      <tbody>
        {runs.map((run) => {
          const group = run.rows.length > 1 ? run : undefined;
          const expanded = open.has(run.id);
          const toggle = () => {
            const next = new Set(open);
            if (expanded) next.delete(run.id);
            else next.add(run.id);
            setOpen(next);
          };
          const shown = group && !expanded ? run.rows.slice(0, 1) : run.rows;
          return shown.map((row, index) => (
            <HistoryRow
              key={row.key}
              row={row}
              lead={index === 0}
              group={group}
              expanded={expanded}
              onToggle={toggle}
              first={run === firstGroup}
            />
          ));
        })}
      </tbody>
    </table>
  );
}

// ---- Shell ----------------------------------------------------------------------------------

const TABS_ID = 'task-tabs';
const TABS = [
  { value: 'now', label: 'Now' },
  { value: 'history', label: 'History' },
];

function TaskView({ fixture, now, tab, onTab, onClose }) {
  const value = fixture['task.get'];
  const row = fixture['status.get'].tasks.find((task) => task.key === value.task.key);
  return (
    <DS.Modal
      open
      onClose={onClose}
      title={shortKey(value.task.key)}
      detail={
        <Fragment>
          {' · '}
          <span className="task-column">{value.task.column.toUpperCase()}</span>
          {' · '}
          {age(row.columnEnteredAt, now)}
        </Fragment>
      }
      actions={<DS.Tabs id={TABS_ID} label="Task view" tabs={TABS} value={tab} onChange={onTab} />}
    >
      <DS.TabPanel tabsId={TABS_ID} value={tab}>
        {tab === 'now' ? (
          <NowTab value={value} now={now} />
        ) : (
          <HistoryTab events={fixture['task.history'].events} />
        )}
      </DS.TabPanel>
    </DS.Modal>
  );
}

function App({ fixture }) {
  const [preference, setPreference] = useState(initialTheme);
  const [view, setView] = useState(initialState);
  const [tokens, setTokens] = useState(initialTokens);
  const [color, setColor] = useState(initialColor);
  // On the root element: the modal renders outside the shell.
  document.documentElement.dataset.tokens = tokens;
  document.documentElement.dataset.color = color;
  document.documentElement.dataset.marks = marks;
  const now = Date.parse(fixture.now);
  return (
    <div className="shell">
      <BoardArea fixture={fixture} now={now} onOpen={() => setView('task')} />
      {view !== 'board' && (
        <TaskView
          fixture={fixture}
          now={now}
          tab={view === 'history' ? 'history' : 'now'}
          onTab={(tab) => setView(tab === 'history' ? 'history' : 'task')}
          onClose={() => setView('board')}
        />
      )}
      <footer className="proto-bar">
        <span className="proto-bar-note">prototype board-v1-1 · {view}</span>
        <span className="proto-bar-switches">
          <button
            type="button"
            className="proto-bar-switch"
            title="Dark theme tokens: muted text and lines as proposed, or as they are now"
            onClick={() => setTokens(tokens === 'proposed' ? 'now' : 'proposed')}
          >
            dark tokens: {tokens}
          </button>
          <button
            type="button"
            className="proto-bar-switch"
            title="Tints on the card cells, markers and link chips"
            onClick={() => setColor(color === 'on' ? 'off' : 'on')}
          >
            colour: {color}
          </button>
        </span>
        <DS.ThemeSwitch
          value={preference}
          onChange={(value) => {
            setPreference(value);
            applyTheme(value);
          }}
        />
      </footer>
    </div>
  );
}

applyTheme(initialTheme);
fetch('fixture.json')
  .then((response) => response.json())
  .then((fixture) => {
    DS.ReactDOM.createRoot(document.getElementById('root')).render(<App fixture={fixture} />);
  });
