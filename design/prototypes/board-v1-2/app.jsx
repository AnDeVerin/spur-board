// Board V1.2 prototype: the board ready for a second project's flow.
//   1. Backlog group: `todo`, `triage` and `ready-for-dev` read as one group.
//   2. Manual order: a third sort mode, `M`, beside `K` and `T`; drag, keys and a card menu.
//      A move between Backlog parts asks for a reason.
//   3. Approval freshness and 4. the QA submit basis, on the card and in the task view.
//   5. Column help: who acts and the rules, from the column head.
//   6. An orchestrator turn closed by the operator. 7. New Why rows, inbox item, service source.
// The card, the column and the board header are simplified stand-ins for the app's own parts;
// the proposed parts carry a `proposed-*` class and a `data-proposed` attribute.
const { useState, useRef, useLayoutEffect, useEffect, Fragment } = DS.React;

const params = new URLSearchParams(location.search);
const pick = (name, allowed) => {
  const value = params.get(name);
  return allowed.includes(value) ? value : allowed[0];
};
const state = pick('state', [
  'default',
  'todo-collapsed',
  'mirror-failing',
  'sort-manual',
  'sort-menu',
  'drag',
  'drag-off',
  'reorder-failed',
  'order-changed',
  'card-menu',
  'move',
  'move-mirror',
  'approval-stale',
  'approval-stale-quiet',
  'approval-multi',
  'approval-rewritten',
  'approval-uncounted',
  'qa-carried',
  'qa-skipped',
  'operator-turn',
  'operator-submit',
  'operator-return',
  'operator-turn-closed',
  'task-move',
  'task-history',
  'why-checks',
  'why-review-rule',
  'why-merge-unknown',
  'inbox',
  'services',
  'services-failing',
  'column-rules',
  'column-actor',
  'column-actor-no-session',
  'empty',
]);
const initialTheme = pick('theme', ['dark', 'light']);
const marks = pick('marks', ['on', 'off']);
const initialProject = pick('project', ['acme-web', 'orbit-api']);
/** Which column's help is open in the `column-*` states. */
const helpColumn = params.get('column') ?? (state === 'column-rules' ? 'dev' : 'qa');

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
function age(iso, now) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) {
    const hours = Math.floor(minutes / 60);
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(minutes / 1440)}d`;
}
const columnLabel = (column) => column.label ?? column.id;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function Proposed() {
  return <span className="proposed-label">proposed</span>;
}

// ---- 2. Sort: K, T and the manual order M ---------------------------------------------------

const SORT_HINT = {
  'entered-asc': 'Longest in the column first',
  'entered-desc': 'Newest in the column first',
  'key-asc': 'Lowest key first',
  'key-desc': 'Highest key first',
  manual: 'Manual order, the same for everyone',
};
/** The head shows the first letter of the chosen field; the menu has the full names. */
const FIELDS = [
  { id: 'entered', label: 'Time', hint: 'Time in the column' },
  { id: 'key', label: 'Key', hint: 'Task key' },
  { id: 'manual', label: 'Manual', hint: 'One order for everyone; drag a card to move it' },
];
const byKey = (a, b) => a.key.localeCompare(b.key, 'en', { numeric: true });
const byEntered = (a, b) => Date.parse(a.columnEnteredAt) - Date.parse(b.columnEnteredAt);
const byPosition = (a, b) => a.position - b.position;
function sortRows(rows, sort) {
  if (sort === 'manual') return [...rows].sort(byPosition);
  const [field, direction] = sort.split('-');
  const sorted = [...rows].sort(field === 'key' ? byKey : byEntered);
  return direction === 'asc' ? sorted : sorted.reverse();
}

/**
 * Proposed. One letter, the chosen field; a click opens a small menu of the three fields, as the
 * theme switch does. K and T have a direction button beside the letter; M has none.
 * The menu is `DS.HoverMenu` in every way but two: a text trigger and it opens downward.
 */
function SortControl({ sort, onChange, label, first, defaultOpen }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const root = useRef(null);
  const field = sort === 'manual' ? 'manual' : sort.split('-')[0];
  const direction = sort === 'manual' ? 'asc' : sort.split('-')[1];
  const current = FIELDS.find((entry) => entry.id === field);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event) => !root.current.contains(event.target) && setOpen(false);
    const key = (event) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <span className="proposed-sort" data-proposed="sort" role="group" aria-label={label} ref={root}>
      {first && <Proposed />}
      <button
        type="button"
        className={`proposed-sort-button ${DS.focusRing}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sorted by ${current.label}`}
        title={`Sorted by ${current.label.toLowerCase()}. Click to choose.`}
        onClick={() => setOpen(!open)}
      >
        {current.label[0]}
      </button>
      {field !== 'manual' && (
        <button
          type="button"
          className={`proposed-sort-button ${DS.focusRing}`}
          aria-label={SORT_HINT[sort]}
          title={`${SORT_HINT[sort]}. Click to reverse.`}
          onClick={() => onChange(`${field}-${direction === 'asc' ? 'desc' : 'asc'}`)}
        >
          {direction === 'asc' ? '↑' : '↓'}
        </button>
      )}
      {open && (
        <span className="proposed-sort-menu" role="menu" aria-label={label}>
          {FIELDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="menuitemradio"
              aria-checked={entry.id === field}
              className={`proposed-sort-item ${DS.focusRing}`}
              title={entry.hint}
              onClick={() => {
                onChange(entry.id === 'manual' ? 'manual' : `${entry.id}-${direction}`);
                setOpen(false);
              }}
            >
              {entry.label}
              <span className="proposed-sort-tick">
                <DS.Icon name="check" />
              </span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

// ---- 5. Column help: who acts and the rules -------------------------------------------------

/** Proposed icons: the system has `person` only. Drawn on the 16px grid of `DS.Icon`. */
const ACTOR_ICONS = {
  // An agent session: worker, orchestrator or curator.
  agent: (
    <Fragment>
      <rect x="3" y="5.5" width="10" height="7.5" />
      <path d="M8 5.5V3.2M6 8.6v1.6M10 8.6v1.6" />
      <circle cx="8" cy="2.4" r="0.7" />
    </Fragment>
  ),
  // The dispatcher: the board moves the task by its conditions, nobody takes a turn.
  dispatcher: (
    <Fragment>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2M3.5 3.5l1.5 1.5M11 11l1.5 1.5M3.5 12.5L5 11M11 5l1.5-1.5" />
    </Fragment>
  ),
  // A mirror of a tracker field.
  mirror: (
    <Fragment>
      <path d="M8 2v12" strokeDasharray="1.6 1.6" />
      <path d="M5.6 4.5L2 11.5h3.6zM10.4 4.5l3.6 7h-3.6z" />
    </Fragment>
  ),
};
/** Who moves a task in this column: a person, an agent, the dispatcher or a mirror. */
function actorKind(column) {
  if (column.group === 'todo') return column.source.kind === 'mirror' ? 'mirror' : 'person';
  const kind = column.executor.kind;
  return kind === 'operator' ? 'person' : kind === 'dispatcher' ? 'dispatcher' : 'agent';
}
function ActorIcon({ kind }) {
  if (kind === 'person') return <DS.Icon name="person" />;
  return (
    <svg className="proposed-icon" viewBox="0 0 16 16" aria-hidden="true" data-proposed="icon">
      {ACTOR_ICONS[kind]}
    </svg>
  );
}

const sessionHref = (id) => `https://example.test/spur/sessions/${id}`;
function SessionLink({ id }) {
  return (
    <a className={`help-session ${DS.focusRing}`} href={sessionHref(id)}>
      <DS.Icon name="term" />
      {id}
    </a>
  );
}

function executorText(column) {
  const { kind, name } = column.executor;
  return name ? `${kind} ${name}` : kind;
}

function RulesHelp({ info }) {
  return (
    <Fragment>
      <section className="help-part">
        <h4 className="help-title">
          Leaves to {info.exit.to} when{info.exit.conditions.length > 1 ? ' all hold' : ''}
        </h4>
        {info.exit.conditions.length === 0 ? (
          <p className="help-text">Nothing leaves this column.</p>
        ) : (
          <ol className="help-list">
            {info.exit.conditions.map((condition) => (
              <li key={condition.id}>{condition.text}</li>
            ))}
          </ol>
        )}
      </section>
      {info.returns.length > 0 && (
        <section className="help-part">
          <h4 className="help-title">Returns to dev when any holds</h4>
          <ul className="help-list">
            {info.returns.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </section>
      )}
      {info.limits && (
        <section className="help-part">
          <h4 className="help-title">Limits</h4>
          <p className="help-text">
            {info.limits.cycleLimit} returns, then the task stops for the operator. After{' '}
            {info.limits.courseCheckAfter} returns the {info.limits.courseCheckTo} checks the
            course.
          </p>
        </section>
      )}
    </Fragment>
  );
}

/** Who moves a task into a Backlog part: the operator by hand, or a mirror. */
function MovedBy({ source, now }) {
  if (source.kind === 'manual')
    return (
      <p className="help-text">
        <b>operator</b> · you, by hand, with a reason
      </p>
    );
  return (
    <Fragment>
      <p className="help-text">
        <b>mirror</b> · GitHub Project <b>{source.name}</b> · {source.field}
      </p>
      {source.health === 'failing' ? (
        <DS.Banner
          variant="warning"
          icon="pulse"
          detail={`${source.error}. Last read ${clock(source.readAt)}. Tasks stay where they were.`}
        >
          Not readable: frozen
        </DS.Banner>
      ) : (
        <p className="help-text help-live">
          <DS.StatusDot tone="ok" />
          read {age(source.readAt, now)} ago
        </p>
      )}
      <p className="help-text">No manual move into or out of this part.</p>
    </Fragment>
  );
}

function WhoHelp({ column, info, noSession, now }) {
  const { executor, escalation } = info;
  const bound = executor.project !== undefined;
  const session = noSession ? null : executor.session;
  if (column.group === 'todo')
    return (
      <section className="help-part">
        <h4 className="help-title">Moves tasks here</h4>
        <MovedBy source={column.source} now={now} />
      </section>
    );
  return (
    <Fragment>
      <section className="help-part">
        <h4 className="help-title">Acts here</h4>
        {bound ? (
          <Fragment>
            <p className="help-text">
              <b>{executor.kind}</b> · Spur project <b>{executor.project}</b> · role {executor.role}
            </p>
            {session ? (
              <p className="help-text help-live">
                <DS.StatusDot tone="ok" />
                live session <SessionLink id={session.id} />
              </p>
            ) : (
              <DS.Banner
                variant="warning"
                icon="pulse"
                detail={`Start a session of ${executor.project}; open turns wait until then.`}
              >
                No live session
              </DS.Banner>
            )}
          </Fragment>
        ) : (
          <p className="help-text">
            {executor.kind === 'operator' ? (
              <Fragment>
                <b>operator</b> · you
              </Fragment>
            ) : executor.kind === 'dispatcher' ? (
              <Fragment>
                <b>dispatcher</b> · the board itself. Nobody takes a turn: the task leaves when the
                rules hold.
              </Fragment>
            ) : (
              <Fragment>
                <b>worker</b> · the worker of the task
              </Fragment>
            )}
          </p>
        )}
      </section>
      <section className="help-part">
        <h4 className="help-title">Questions go</h4>
        <p className="help-text help-chain">
          {escalation.chain.map((step, index) => (
            <Fragment key={index}>
              {index > 0 && <span className="help-arrow">→</span>}
              {typeof step === 'string' ? (
                <span>{step}</span>
              ) : (
                <span>
                  {step.role} <SessionLink id={step.session} />
                </span>
              )}
            </Fragment>
          ))}
        </p>
      </section>
      {escalation.silent && (
        <section className="help-part">
          <h4 className="help-title">When the executor is silent</h4>
          <p className="help-text">
            A reminder after {escalation.silent.remindAfterMin} min of a quiet turn
            {escalation.silent.operatorItemAfterMin === null
              ? '.'
              : `; with no live session, an item in your inbox after ${escalation.silent.operatorItemAfterMin} min.`}
          </p>
        </section>
      )}
    </Fragment>
  );
}

const HELP_TABS = [
  { value: 'who', label: 'Who' },
  { value: 'rules', label: 'Rules' },
];

/**
 * Proposed. A panel under the column head with two tabs, Who first. It is wider than a column,
 * stays inside the window and follows its column when the board scrolls. Closes on Escape, on a
 * click outside and on its own button.
 */
function HelpPopover({ id, title, tab, onTab, onClose, children }) {
  const panel = useRef(null);
  const [box, setBox] = useState(null);
  useLayoutEffect(() => {
    // The head's own ref is not attached yet on the first mount: read the parent instead.
    const head = panel.current.parentElement;
    // A help opened by URL may belong to a column outside the window.
    head.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const place = () => {
      const rect = head.getBoundingClientRect();
      const width = panel.current.offsetWidth;
      // Kept inside the window while its column shows; it leaves the window with the column.
      const shown = rect.right > 0 && rect.left < innerWidth;
      setBox({
        top: rect.bottom + 4,
        left: shown ? Math.max(8, Math.min(rect.left, innerWidth - width - 8)) : rect.left,
      });
    };
    place();
    // Scroll does not bubble: capture it from the board and from a folded group alike.
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    return () => {
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
    };
  }, []);
  useEffect(() => {
    const key = (event) => event.key === 'Escape' && onClose();
    const click = (event) => {
      if (!panel.current.parentElement.contains(event.target)) onClose();
    };
    addEventListener('keydown', key);
    addEventListener('mousedown', click);
    return () => {
      removeEventListener('keydown', key);
      removeEventListener('mousedown', click);
    };
  }, []);
  return (
    <div
      ref={panel}
      className="proposed-popover"
      data-proposed="popover"
      role="dialog"
      aria-label={title}
      style={box ? { top: box.top, left: box.left } : { visibility: 'hidden' }}
    >
      <div className="proposed-popover-head">
        <span className="proposed-popover-title">{title}</span>
        <DS.Tabs id={id} label="Column help" tabs={HELP_TABS} value={tab} onChange={onTab} />
        <DS.IconButton icon="x" label="Close" size="small" onClick={onClose} />
      </div>
      <div className="proposed-popover-body">{children}</div>
    </div>
  );
}

// ---- Card and column stand-ins --------------------------------------------------------------

function prCells(pr, watch) {
  const { checks, threads, reviewsOnHead: reviews } = pr;
  const total = checks.pass + checks.fail + checks.pending;
  const { worst } = approvalSummary(pr, watch);
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
      // Proposed: an approval that predates changes in watched directories reads as pending.
      tone:
        reviews.changesRequested.length > 0
          ? 'bad'
          : reviews.approved.length === 0
            ? 'none'
            : worst?.loud
              ? 'pend'
              : 'ok',
      suffix: reviews.changesRequested.length > 0 ? null : approvalSuffix(worst),
    },
  ];
}

/** Proposed icon: the grip of a card that can be dragged, on the 16px grid. */
function GripIcon() {
  return (
    <svg className="proposed-icon proposed-grip" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5v.01M10 3.5v.01M6 8v.01M10 8v.01M6 12.5v.01M10 12.5v.01" />
    </svg>
  );
}

/** A Backlog part whose tasks the operator moves by hand. */
const manualPart = (column) => column.group === 'todo' && column.source.kind === 'manual';
const mirrorNote = (column) =>
  `${columnLabel(column).replace(/^./, (letter) => letter.toUpperCase())} mirrors the GitHub Project "${column.source.name}". Change the status there.`;

/**
 * What the card menu offers: the ends of the manual order, and the other Backlog parts. A move
 * into or out of a mirrored part is listed but disabled, with the reason as a note.
 */
function cardActions(row, column, rows, manual, view) {
  const items = [];
  if (manual) {
    const order = sortRows(rows, 'manual');
    items.push(
      { id: 'top', label: 'Move to top', disabled: order[0].key === row.key },
      { id: 'bottom', label: 'Move to bottom', disabled: order.at(-1).key === row.key },
    );
  }
  let note = null;
  if (column.group === 'todo') {
    const fromMirror = column.source.kind === 'mirror';
    for (const part of view.parts.filter((entry) => entry.id !== column.id)) {
      const blocked = fromMirror || part.source.kind === 'mirror';
      if (blocked) note = mirrorNote(fromMirror ? column : part);
      items.push({
        id: `part:${part.id}`,
        label: `Move to ${columnLabel(part)}…`,
        disabled: blocked,
        // A rule parts the moves to another part from the moves inside the column.
        group: 'part',
      });
    }
  }
  return { items, note };
}

/**
 * Proposed. The reason form of a move between Backlog parts, opened under the card from its
 * menu or by a drop on another part. The reason is required; sending the form is the
 * confirmation.
 */
function MoveForm({ row, to, onMove, onCancel }) {
  const [reason, setReason] = useState('');
  const target = columnLabel(to);
  return (
    <div className="proposed-move" data-proposed="move">
      <Proposed />
      <DS.FormRow
        label={`Move ${shortKey(row.key)} to ${target}: reason`}
        hint="Required. It goes to the task history."
      >
        <DS.TextArea value={reason} onChange={setReason} label="Reason" />
      </DS.FormRow>
      <div className="proposed-move-actions">
        <DS.Button variant="primary" disabled={reason.trim() === ''} onClick={() => onMove(reason)}>
          Move to {target}
        </DS.Button>
        <DS.Button onClick={onCancel}>Cancel</DS.Button>
      </div>
    </div>
  );
}

/**
 * A stand-in for the app card. Proposed here: the grip in the manual order, the menu button
 * among the quick links, the move form and the marks of a drag.
 */
function Card({ row, now, column, rows, manual, view, ghost }) {
  const turn = row.turn;
  const kind =
    turn === null ? 'none' : turn.addressee === 'operator' ? 'you' : turn.taken ? 'agent' : 'wait';
  const pr = row.prSummary?.[0];
  const quick = [
    'ticket',
    ...(row.links.prs.length > 0 ? ['pr'] : []),
    ...(row.links.sessions.length > 0 ? ['term'] : []),
  ];
  const { items, note } = ghost ? { items: [] } : cardActions(row, column, rows, manual, view);
  // Where the merge is decided: the approval hint and the QA basis show in ready-to-merge only.
  const deciding = column.id === 'ready-to-merge' && pr;
  const approval = deciding ? approvalChip(approvalSummary(pr, view.watch).worst) : null;
  const qa = deciding ? qaChip(row.submission) : null;
  const menuOpen = !ghost && view.menu === row.key;
  const moving = !ghost && view.moving?.key === row.key ? view.moving : null;
  const dragging = !ghost && view.drag?.key === row.key;
  const moved = !ghost && view.moved?.key === row.key ? view.moved : null;
  const choose = (id) => {
    view.setMenu(null);
    if (id === 'top') view.reorder(column.id, row.key, 0);
    else if (id === 'bottom') view.reorder(column.id, row.key, rows.length);
    else view.setMoving({ key: row.key, to: id.slice(5) });
  };
  return (
    <div
      className={`card-wrap ${DS.quiet}${ghost ? ' proposed-ghost' : ''}`}
      data-turn={kind}
      data-key={ghost ? undefined : row.key}
      data-manual={manual ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      data-moved={moved ? '' : undefined}
      draggable={!ghost}
      onDragStart={(event) => view.dragStart(event, row, column, manual)}
      onDragEnd={view.dragEnd}
    >
      <a
        className={`card ${DS.focusRing}`}
        href="#"
        draggable={false}
        title={manual ? 'Drag to reorder, or Alt+Up and Alt+Down' : undefined}
        onClick={(event) => {
          event.preventDefault();
          view.open(row.key);
        }}
        onKeyDown={(event) => {
          if (!manual || !event.altKey) return;
          const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
          if (step === 0) return;
          event.preventDefault();
          view.step(column.id, row.key, step);
        }}
      >
        <span className="card-key-row">
          {manual && <GripIcon />}
          <b className="card-key">{shortKey(row.key)}</b>
          <span className="card-entered" title="Time in this column">
            {age(row.columnEnteredAt, now)}
          </span>
          {moved && <span className="proposed-moved-note">{moved.note}</span>}
        </span>
        <span className="card-title">{row.ticket.title}</span>
        {pr ? (
          <span className="card-cells">
            {prCells(pr, view.watch).map((cell) => (
              <span
                key={cell.icon}
                className="card-cell"
                data-tone={cell.tone}
                title={cell.suffix?.title}
              >
                <DS.Icon name={cell.icon} />
                {cell.text}
                {cell.suffix?.text && (
                  <span className="proposed-cell-suffix">{cell.suffix.text}</span>
                )}
              </span>
            ))}
          </span>
        ) : (
          kind !== 'none' && <span className="card-placeholder">no PR yet</span>
        )}
        {(row.openBlocks > 0 || row.returned || approval || qa) && (
          <span className="card-markers">
            {approval && (
              <DS.Chip tone="warn" title={approval.title}>
                <DS.Icon name="person" />
                {approval.text}
              </DS.Chip>
            )}
            {qa && (
              <DS.Chip tone={qa.tone} title={qa.title}>
                {qa.text}
              </DS.Chip>
            )}
            {row.openBlocks > 0 && (
              <span className="card-marker" data-marker="block">
                <DS.Chip>
                  <DS.Icon name="block" />
                  {plural(row.openBlocks, 'block')}
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
        {items.length > 0 && (
          <button
            type="button"
            className={`card-link proposed-card-more ${DS.focusRing}`}
            data-proposed="card-menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Move ${shortKey(row.key)}`}
            title="Move this task"
            onClick={() => view.setMenu(menuOpen ? null : row.key)}
          >
            ⋯
          </button>
        )}
      </span>
      {menuOpen && (
        <span className="proposed-menu proposed-card-menu" role="menu" aria-label="Move this task">
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`proposed-menu-item ${DS.focusRing}`}
              data-rule={index > 0 && item.group !== items[index - 1].group ? '' : undefined}
              disabled={item.disabled}
              onClick={() => choose(item.id)}
            >
              {item.label}
            </button>
          ))}
          {note && <span className="proposed-menu-note">{note}</span>}
        </span>
      )}
      {moving && (
        <MoveForm
          row={row}
          to={view.parts.find((part) => part.id === moving.to)}
          onMove={() => view.move(row.key, moving.to)}
          onCancel={() => view.setMoving(null)}
        />
      )}
    </div>
  );
}

/**
 * The cards of a column and, proposed, where a drag may land: a line between two cards in the
 * manual order, the whole list for a move from another Backlog part, or a refusal.
 */
function CardZone({ className, column, rows, sort, now, view }) {
  const manual = sort === 'manual';
  const sorted = sortRows(rows, sort);
  const drop = view.drop?.column === column.id ? view.drop : null;
  const handlers = view.zone(column, manual);
  if (column.id === 'done')
    return (
      <div className={className}>
        {sorted.map((row) => (
          <a
            key={row.key}
            className={`done-row ${DS.focusRing}`}
            href="#"
            onClick={(event) => event.preventDefault()}
          >
            <span className="done-check">
              <DS.Icon name="check" />
            </span>
            <b className="done-key">{shortKey(row.key)}</b>
            <span className="done-title">{row.ticket.title}</span>
            <span className="card-entered">{age(row.columnEnteredAt, now)}</span>
          </a>
        ))}
      </div>
    );
  const line = <div key="drop-line" className="proposed-drop-line" data-proposed="drop" />;
  // The card in the hand, for `?state=drag`; a real drag shows the browser's own image.
  const ghost = view.drag?.still && (
    <Card
      key="ghost"
      row={view.drag.row}
      now={now}
      column={column}
      rows={rows}
      manual
      view={view}
      ghost
    />
  );
  return (
    <div
      className={`${className} proposed-zone`}
      data-drop={drop?.refused ? 'refused' : drop?.part ? 'part' : undefined}
      {...handlers}
    >
      {drop?.part && (
        <p className="proposed-zone-note">
          Drop to move to {columnLabel(column)}. A reason is asked.
        </p>
      )}
      {drop?.refused && <p className="proposed-zone-note">{mirrorNote(drop.mirror)}</p>}
      {sorted.flatMap((row, index) => [
        ...(drop?.index === index ? [line, ghost] : []),
        <Card
          key={row.key}
          row={row}
          now={now}
          column={column}
          rows={rows}
          manual={manual}
          view={view}
        />,
      ])}
      {drop?.index === sorted.length && [line, ghost]}
    </div>
  );
}

/** Proposed. A line under the column head: why a drag did nothing, or why a move came back. */
function ZoneNotice({ column, view }) {
  const notice = view.notice?.column === column.id ? view.notice : null;
  if (!notice) return null;
  if (notice.kind === 'hint')
    return (
      <p className="proposed-hint" data-proposed="hint">
        Cards keep the chosen sort. To reorder by hand,{' '}
        <button
          type="button"
          className={`proposed-hint-action ${DS.focusRing}`}
          onClick={() => {
            view.setSort(column.id, 'manual');
            view.setNotice(null);
          }}
        >
          switch to Manual
        </button>
        .
      </p>
    );
  return (
    <div className="proposed-frozen" data-proposed="reorder-failed">
      <DS.Banner
        variant="error"
        icon="back"
        detail={`${notice.reason} The card is back where it was.`}
        action={<DS.Button onClick={() => view.setNotice(null)}>Dismiss</DS.Button>}
      >
        {shortKey(notice.key)} not moved
      </DS.Banner>
    </div>
  );
}

/**
 * Proposed. The second line of a column head is one button: an icon for who moves a task here
 * (a person, an agent, the dispatcher or a mirror) and their name. It opens the help panel.
 */
function ActorButton({ column, open, onClick, warn, now }) {
  const kind = actorKind(column);
  const source = column.group === 'todo' ? column.source : null;
  const failing = source?.health === 'failing';
  const text = source
    ? source.kind === 'mirror'
      ? `mirror · ${source.name}`
      : 'manual'
    : executorText(column);
  return (
    <button
      type="button"
      className={`column-exec proposed-actor ${DS.focusRing}`}
      data-proposed="actor"
      data-kind={kind}
      data-warn={warn || failing ? '' : undefined}
      aria-expanded={open}
      title={
        failing
          ? `Mirror not readable: ${source.error}. Click for details.`
          : `How ${columnLabel(column)} works: who acts and the rules`
      }
      onClick={onClick}
    >
      <ActorIcon kind={kind} />
      <span className="proposed-actor-text">
        {text}
        {failing && ' · frozen'}
        {warn && ' · no live session'}
      </span>
    </button>
  );
}

/** The column head: name and count on the first line; who acts and the sort on the second. */
function ColumnHead({
  column,
  count,
  info,
  sort,
  onSort,
  first,
  part,
  initialHelp,
  noSession,
  now,
}) {
  const [help, setHelp] = useState(initialHelp ?? null);
  const label = columnLabel(column);
  const warn = Boolean(noSession && column.executor.name);
  return (
    <div className={`column-head ${DS.quiet}`} data-part={part ? '' : undefined}>
      <div className="column-name">
        <h2 className="column-label">{label}</h2>
        <span className="column-count">{count}</span>
      </div>
      <div className="column-sub">
        <ActorButton
          column={column}
          open={help !== null}
          onClick={() => setHelp(help === null ? 'who' : null)}
          warn={warn}
          now={now}
        />
        {first && <Proposed />}
        {count > 0 && (
          <SortControl
            sort={sort}
            onChange={onSort}
            label={`Sort ${label}`}
            first={first}
            defaultOpen={first && state === 'sort-menu'}
          />
        )}
      </div>
      {help !== null && (
        <HelpPopover
          id={`help-${column.id}`}
          title={label}
          tab={help}
          onTab={setHelp}
          onClose={() => setHelp(null)}
        >
          {help === 'rules' ? (
            <RulesHelp info={info} />
          ) : (
            <WhoHelp column={column} info={info} noSession={noSession} now={now} />
          )}
        </HelpPopover>
      )}
    </div>
  );
}

function MirrorNotice({ source }) {
  return (
    <div className="proposed-frozen" data-proposed="frozen">
      <DS.Banner
        variant="warning"
        icon="pulse"
        detail={`${source.error}. Last read ${clock(source.readAt)}. Tasks stay where they were.`}
      >
        Mirror not readable: frozen
      </DS.Banner>
    </div>
  );
}

function Column({ column, rows, now, view, first }) {
  const sort = view.sorts[column.id] ?? view.initialSort;
  const label = columnLabel(column);
  if (rows.length === 0 && column.source?.health !== 'failing') {
    const drop = view.drop?.column === column.id ? view.drop : null;
    return (
      <section
        className={`spine ${DS.quiet}`}
        title={
          drop?.refused
            ? mirrorNote(column)
            : `${label}: empty · ${column.group === 'todo' ? column.source.kind : executorText(column)}`
        }
        data-part={column.group === 'todo' ? '' : undefined}
        data-drop={drop?.refused ? 'refused' : drop?.part ? 'part' : undefined}
        {...view.zone(column, false)}
      >
        <span className="column-count">0</span>
        <h2 className="column-label spine-name">{label}</h2>
      </section>
    );
  }
  const done = column.id === 'done';
  return (
    <section className="column">
      <ColumnHead
        column={column}
        count={rows.length}
        info={view.describe[column.id]}
        sort={sort}
        onSort={(value) => view.setSort(column.id, value)}
        first={first}
        part={column.group === 'todo'}
        initialHelp={view.helpFor(column.id)}
        noSession={state === 'column-actor-no-session' && column.id === helpColumn}
        now={now}
      />
      {column.source?.health === 'failing' && <MirrorNotice source={column.source} />}
      <ZoneNotice column={column} view={view} />
      <CardZone
        className={done ? `column-body done ${DS.quiet}` : 'column-body'}
        column={column}
        rows={rows}
        sort={sort}
        now={now}
        view={view}
      />
    </section>
  );
}

// ---- 1. Backlog group -----------------------------------------------------------------------

/**
 * Proposed. The Todo-group columns (`todo`, `triage`, `ready-for-dev`) under a shared band named
 * Backlog: the name, a fold control and the total. Unfolded, each part is an ordinary column.
 * Folded, the group is one column with a section per part. Folding is the viewer's own state,
 * kept like the column sort; the prototype takes it from the URL state only.
 */
function BacklogGroup({ columns, rowsOf, now, view }) {
  const [folded, setFolded] = useState(view.backlogFolded);
  const total = columns.reduce((sum, column) => sum + rowsOf(column).length, 0);
  const failing = columns.some((column) => column.source?.health === 'failing');
  return (
    <section className="proposed-group" data-proposed="group" data-folded={folded ? '' : undefined}>
      <div className={`proposed-group-head ${DS.quiet}`}>
        <button
          type="button"
          className={`proposed-group-toggle ${DS.focusRing}`}
          aria-expanded={!folded}
          title={folded ? 'Unfold Backlog into columns' : 'Fold Backlog into one column'}
          onClick={() => setFolded(!folded)}
        >
          <span className="proposed-caret" data-expanded={folded ? undefined : ''}>
            <DS.Icon name="caret" />
          </span>
          <h2 className="column-label">backlog</h2>
        </button>
        <Proposed />
        {failing && (
          <span className="proposed-group-warn" title="A mirror is not readable">
            <DS.StatusDot tone="warn" />
          </span>
        )}
        <span className="column-count">{total}</span>
      </div>
      {folded ? (
        <div className="proposed-group-stack">
          {columns.map((column) => {
            const rows = rowsOf(column);
            const sort = view.sorts[column.id] ?? view.initialSort;
            return (
              <div key={column.id} className="proposed-group-section">
                <ColumnHead
                  column={column}
                  count={rows.length}
                  info={view.describe[column.id]}
                  sort={sort}
                  onSort={(value) => view.setSort(column.id, value)}
                  part
                  initialHelp={view.helpFor(column.id)}
                  now={now}
                />
                {column.source?.health === 'failing' && <MirrorNotice source={column.source} />}
                <ZoneNotice column={column} view={view} />
                {rows.length === 0 && <p className="proposed-group-empty">empty</p>}
                <CardZone
                  className="proposed-group-cards"
                  column={column}
                  rows={rows}
                  sort={sort}
                  now={now}
                  view={view}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="proposed-group-parts">
          {columns.map((column) => (
            <Column key={column.id} column={column} rows={rowsOf(column)} now={now} view={view} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---- 3. Approval freshness ------------------------------------------------------------------

const NOT_COUNTED = {
  history_rewritten: 'history rewritten after the approval',
  rate_limit: 'GitHub rate limit',
  pr_too_large: 'the PR is too large to compare',
};
/**
 * How one approval stands against the head. `loud` asks for a look before the merge: watched
 * directories changed after it, or the history was rewritten. The rest stay quiet.
 */
function approvalState(approval, watch) {
  if (approval.notCounted === 'history_rewritten') return { kind: 'rewritten', loud: true };
  if (approval.notCounted) return { kind: 'uncounted', loud: false };
  if (approval.onHead) return { kind: 'fresh', loud: false };
  const watched = approval.dirsChanged.filter((dir) => watch.includes(dir));
  return { kind: 'stale', loud: watched.length > 0, watched };
}
/** The card shows the loudest approval: a hint, never a condition. */
function approvalSummary(pr, watch) {
  const states = (pr.approvals ?? []).map((approval) => ({
    approval,
    ...approvalState(approval, watch),
  }));
  const rank = { rewritten: 4, stale: 3, uncounted: 1, fresh: 0 };
  const sorted = [...states].sort(
    (a, b) => Number(b.loud) - Number(a.loud) || rank[b.kind] - rank[a.kind],
  );
  return { states, worst: sorted[0] ?? null };
}
function approvalChip(worst) {
  if (!worst?.loud) return null;
  return worst.kind === 'rewritten'
    ? {
        text: 'approval: history rewritten',
        title: 'The history was rewritten after the approval; what changed since is not counted.',
      }
    : {
        text: `approved before ${worst.watched.join(' ')}`,
        title: `${worst.approval.author} approved ${worst.approval.sha}; ${plural(worst.approval.commitsAfter, 'commit')} since changed ${worst.watched.join(', ')}.`,
      };
}
/** The suffix of the approvals cell on a card: quiet facts only. */
function approvalSuffix(worst) {
  if (!worst || worst.kind === 'fresh') return { text: '', title: 'Approved on the head' };
  if (worst.kind === 'stale')
    return {
      text: `+${worst.approval.commitsAfter}`,
      title: `Approved ${plural(worst.approval.commitsAfter, 'commit')} ago; changed since: ${worst.approval.dirsChanged.join(', ') || 'nothing'}`,
    };
  return {
    text: '?',
    title: `Changes since the approval not counted: ${NOT_COUNTED[worst.approval.notCounted]}`,
  };
}

/** Proposed. The approvals of a PR in the task view: who, on which commit, what changed since. */
function Approvals({ pr, watch }) {
  const { states } = approvalSummary(pr, watch);
  if (states.length === 0) return <p className="task-none">No approvals yet</p>;
  return (
    <ul className="proposed-approvals" data-proposed="approvals">
      {states.map(({ approval, kind, loud }) => (
        <li
          key={approval.author}
          className={`proposed-approval ${DS.quiet}`}
          data-loud={loud ? '' : undefined}
        >
          <span className="proposed-approval-who">
            <DS.Icon name="person" />
            <b>{approval.author}</b>
            <code className="task-sha">{approval.sha}</code>
          </span>
          <span className="proposed-approval-what">
            {kind === 'fresh' && 'on the head'}
            {kind === 'stale' && (
              <Fragment>
                {plural(approval.commitsAfter, 'commit')} since
                {approval.dirsChanged.length > 0 && ' · changed'}
                {approval.dirsChanged.map((dir) => (
                  <DS.Chip key={dir} tone={watch.includes(dir) ? 'warn' : 'ghost'}>
                    {dir}
                  </DS.Chip>
                ))}
              </Fragment>
            )}
            {(kind === 'rewritten' || kind === 'uncounted') && (
              <Fragment>
                <DS.Chip tone={kind === 'rewritten' ? 'warn' : 'ghost'}>not counted</DS.Chip>
                {NOT_COUNTED[approval.notCounted]}
              </Fragment>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ---- 4. QA submit basis ---------------------------------------------------------------------

/** `tested` is the quiet default; `carried` and `skipped` are marked where the merge is decided. */
function qaChip(submission) {
  if (!submission || submission.basis === 'tested') return null;
  return submission.basis === 'carried'
    ? {
        tone: 'default',
        text: 'QA carried',
        title: `Verdict carried from ${submission.from}: ${submission.reason}`,
      }
    : { tone: 'warn', text: 'QA skipped', title: `QA skipped: ${submission.reason}` };
}
function Submission({ submission }) {
  if (!submission) return <p className="task-none">No submissions yet</p>;
  const rows = [
    { key: 'Submitted by', value: submission.by.replace('/', ' / ') },
    { key: 'On commit', value: <code className="task-sha">{submission.sha}</code> },
    {
      key: 'Basis',
      value:
        submission.basis === 'tested' ? (
          'tested'
        ) : (
          <span className="proposed-basis" data-proposed="basis">
            <DS.Chip tone={submission.basis === 'skipped' ? 'warn' : 'default'}>
              {submission.basis}
            </DS.Chip>
            {submission.basis === 'carried' && (
              <Fragment>
                from <code className="task-sha">{submission.from}</code>
              </Fragment>
            )}
          </span>
        ),
    },
    ...(submission.reason ? [{ key: 'Reason', value: submission.reason }] : []),
  ];
  return <DS.KeyValueBox rows={rows} />;
}

// ---- 6. An orchestrator turn in the operator's hands ----------------------------------------

const BASES = [
  { value: 'tested', label: 'Tested' },
  { value: 'carried', label: 'Carried' },
  { value: 'skipped', label: 'Skipped' },
];

/**
 * Proposed. The open turn of a column orchestrator, with the two actions the operator may take
 * over: submit, with a basis, or return to Dev with a reason. Both move the task and cannot be
 * undone, so each form states what it does above its button.
 */
function TurnSection({ value, nextColumn, initialForm, closed }) {
  const turn = value.turn;
  const [form, setForm] = useState(initialForm ?? null);
  const [sha, setSha] = useState(value.pr?.head ?? '');
  const [basis, setBasis] = useState(initialForm === 'submit' ? 'carried' : 'tested');
  const [from, setFrom] = useState('');
  const [reason, setReason] = useState('');
  if (!turn) return <p className="task-none">No open turn</p>;
  const [role, name] = turn.addressee.split(':');
  const mine = turn.addressee === 'operator';
  const holder = turn.taken ? `taken by ${turn.taken.by.split('/')[1]}` : 'not taken';
  const needsReason = basis !== 'tested';
  const ready =
    sha.trim() !== '' &&
    (!needsReason || reason.trim() !== '') &&
    (basis !== 'carried' || from.trim() !== '');
  return (
    <div className="proposed-turn" data-proposed="turn">
      <div className="proposed-turn-line">
        <DS.StatusDot tone={turn.taken ? 'working' : 'warn'} hollow={!turn.taken} />
        <b>{turn.id}</b>
        <span>
          {mine ? 'yours' : `${role} ${name}`} · {closed ? 'closed' : holder}
        </span>
        {!mine && !closed && form === null && (
          <span className="proposed-turn-actions">
            <DS.Button onClick={() => setForm('submit')}>Submit…</DS.Button>
            <DS.Button onClick={() => setForm('return')}>Return to dev…</DS.Button>
          </span>
        )}
        {closed && (
          <span className="proposed-turn-actions">
            <DS.Button disabled>Submit…</DS.Button>
            <DS.Button disabled>Return to dev…</DS.Button>
          </span>
        )}
      </div>
      {!mine && !closed && form === null && (
        <p className="proposed-turn-note">
          You can close this turn yourself when the {role} is down or you have the verdict from
          elsewhere.
        </p>
      )}
      {closed && (
        <DS.Banner
          variant="info"
          icon="check"
          detail="Submitted on the head, tested, 2m ago. There is nothing left to take over."
        >
          {turn.id} was closed by {name} / oq-5e12
        </DS.Banner>
      )}
      {form === 'submit' && (
        <div className="proposed-turn-form">
          <DS.FormRow label="Commit" hint="The head of the PR unless you tested another commit.">
            <DS.TextInput value={sha} onChange={setSha} label="Commit" />
          </DS.FormRow>
          <div className="proposed-turn-basis">
            <span className="proposed-turn-label">Basis</span>
            <DS.Tabs id="basis" label="Basis" tabs={BASES} value={basis} onChange={setBasis} />
          </div>
          {basis === 'carried' && (
            <DS.FormRow label="Carried from" hint="A commit of this task with a tested submit.">
              <DS.TextInput
                value={from}
                onChange={setFrom}
                label="Carried from"
                placeholder="commit"
              />
            </DS.FormRow>
          )}
          {needsReason && (
            <DS.FormRow label="Reason" hint="Required. Shown on the card and in the history.">
              <DS.TextArea value={reason} onChange={setReason} label="Reason" />
            </DS.FormRow>
          )}
          <p className="proposed-turn-confirm">
            This closes {turn.id} in your name and moves the task to {nextColumn}. It cannot be
            undone.
          </p>
          <div className="proposed-move-actions">
            <DS.Button variant="primary" disabled={!ready}>
              Submit and move to {nextColumn}
            </DS.Button>
            <DS.Button onClick={() => setForm(null)}>Cancel</DS.Button>
          </div>
        </div>
      )}
      {form === 'return' && (
        <div className="proposed-turn-form">
          <DS.FormRow
            label="Reason"
            hint="Required. The worker reads it as the cause of the return."
          >
            <DS.TextArea value={reason} onChange={setReason} label="Reason" />
          </DS.FormRow>
          <p className="proposed-turn-confirm">
            This closes {turn.id} in your name and returns the task to dev. It cannot be undone, and
            it counts toward the cycle limit.
          </p>
          <div className="proposed-move-actions">
            <DS.Button variant="primary" disabled={reason.trim() === ''}>
              Return to dev
            </DS.Button>
            <DS.Button onClick={() => setForm(null)}>Cancel</DS.Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Task view ------------------------------------------------------------------------------

const TASK_TABS = [
  { value: 'now', label: 'Now' },
  { value: 'history', label: 'History' },
];

function HistoryTab({ events }) {
  return (
    <table className="history" aria-label="Task history">
      <tbody>
        {[...events].reverse().map((event, index) => (
          <tr key={index} className={DS.quiet}>
            <td className="history-when">{clock(event.at)}</td>
            <td className="history-what">
              {event.summary} ·{' '}
              <span className="history-actor">
                {event.actor.replace('agent:', '').replace('/', ' / ')}
              </span>
            </td>
            <td className="history-kind">{event.kind}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A stand-in for the app's task view. Proposed in it: the tabs at the right of the header, the
 * move between Backlog parts, the turn section, the approvals and the submit basis.
 */
function TaskView({ fixture, taskKey, project, view, now, initialTab, onClose }) {
  const [tab, setTab] = useState(initialTab ?? 'now');
  const value = fixture['task.get'][taskKey];
  const row = view.rowOf(taskKey);
  const column = project.columns.find((entry) => entry.id === row.column);
  const ids = project.columns.map((entry) => entry.id);
  const nextColumn = ids[ids.indexOf(column.id) + 1];
  const [moveTo, setMoveTo] = useState(state === 'task-move' ? 'ready-for-dev' : null);
  const parts = column.group === 'todo' ? view.parts.filter((part) => part.id !== column.id) : [];
  const fromMirror = column.source?.kind === 'mirror';
  const orchestrated =
    value.turn && value.turn.addressee !== 'operator' && !value.turn.addressee.startsWith('worker');
  return (
    <div className="proposed-modal" data-proposed="modal-tabs">
      <DS.Modal
        open
        onClose={onClose}
        title={shortKey(taskKey)}
        detail={
          <Fragment>
            {' · '}
            <span className="task-column">{columnLabel(column).toUpperCase()}</span>
            {' · '}
            {age(row.columnEnteredAt, now)}
          </Fragment>
        }
        actions={
          <DS.Tabs
            id="task-tabs"
            label="Task view"
            tabs={TASK_TABS}
            value={tab}
            onChange={setTab}
          />
        }
      >
        <DS.TabPanel tabsId="task-tabs" value={tab}>
          {tab === 'history' ? (
            <HistoryTab events={fixture['task.history'][taskKey].events} />
          ) : (
            <Fragment>
              <div className="task-top">
                <h2 className="task-title">{value.title}</h2>
                <div className="task-links">
                  <span className="task-link" data-kind="ticket">
                    <DS.Icon name="ticket" />
                    ticket {shortKey(taskKey)}
                  </span>
                  {value.pr && (
                    <span className="task-link" data-kind="pr">
                      <DS.Icon name="pr" />
                      PR #{value.pr.number}
                    </span>
                  )}
                </div>
                {parts.length > 0 && (
                  <div className="proposed-task-move" data-proposed="task-move">
                    <span className="proposed-turn-label">Move to</span>
                    {parts.map((part) => {
                      const blocked = fromMirror || part.source.kind === 'mirror';
                      return (
                        <DS.Button
                          key={part.id}
                          disabled={blocked}
                          onClick={() => setMoveTo(part.id)}
                        >
                          {columnLabel(part)}…
                        </DS.Button>
                      );
                    })}
                    {parts.some((part) => fromMirror || part.source.kind === 'mirror') && (
                      <span className="proposed-turn-note">
                        {mirrorNote(
                          fromMirror ? column : parts.find((part) => part.source.kind === 'mirror'),
                        )}
                      </span>
                    )}
                  </div>
                )}
                {moveTo && (
                  <MoveForm
                    row={row}
                    to={view.parts.find((part) => part.id === moveTo)}
                    onMove={() => {
                      view.move(taskKey, moveTo);
                      setMoveTo(null);
                    }}
                    onCancel={() => setMoveTo(null)}
                  />
                )}
              </div>
              <DS.CollapsibleSection title="Why it is here">
                <DS.KeyValueBox
                  rows={value.why.rows.map((entry) => ({
                    ...entry,
                    status: entry.status ?? undefined,
                  }))}
                />
              </DS.CollapsibleSection>
              {orchestrated && (
                <DS.CollapsibleSection title="Turn">
                  <TurnSection
                    value={value}
                    nextColumn={nextColumn}
                    initialForm={
                      state === 'operator-submit'
                        ? 'submit'
                        : state === 'operator-return'
                          ? 'return'
                          : null
                    }
                    closed={state === 'operator-turn-closed'}
                  />
                </DS.CollapsibleSection>
              )}
              {value.pr && (
                <DS.CollapsibleSection title="Approvals" count={value.pr.approvals.length}>
                  <Approvals pr={value.pr} watch={project.approvalWatch} />
                </DS.CollapsibleSection>
              )}
              {project.columns.some((entry) => entry.id === 'qa') && value.pr && (
                <DS.CollapsibleSection title="Latest submission">
                  <Submission submission={value.submission} />
                </DS.CollapsibleSection>
              )}
            </Fragment>
          )}
        </DS.TabPanel>
      </DS.Modal>
    </div>
  );
}

// ---- 7. Inbox item and the services source --------------------------------------------------

function InboxPanel({ fixture, now, onClose }) {
  return (
    <DS.SidePanel
      open
      onClose={onClose}
      icon="inbox"
      title="Inbox"
      detail={` · ${fixture['inbox.list'].items.length}`}
    >
      <ul className="panel-list">
        {fixture['inbox.list'].items.map((item) =>
          item.kind === 'no_recipient' ? (
            <li
              key={item.id}
              className={`panel-item proposed-inbox-item ${DS.quiet}`}
              data-proposed="inbox-item"
            >
              <Proposed />
              <span className="panel-item-head">
                <DS.StatusDot tone="warn" />
                <b>No session to ring for {item.column}</b>
                <span className="panel-item-age">{age(item.oldestAt, now)}</span>
              </span>
              <span className="panel-item-text">
                {item.project} · the {item.column} orchestrator is the Spur project{' '}
                <b>{item.expects}</b>, and it has no live session.{' '}
                {plural(item.turnsWaiting, 'turn')} wait; the oldest for {age(item.oldestAt, now)}.
              </span>
              <span className="panel-item-text">
                Start a session of {item.expects}, or take the turns over in the task view. This
                item clears itself when a session appears.
              </span>
            </li>
          ) : (
            <li key={item.id} className={`panel-item ${DS.quiet}`}>
              <span className="panel-item-head">
                <DS.StatusDot tone="warn" />
                <b>{shortKey(item.key)}</b>
                <span className="panel-item-age">{age(item.at, now)}</span>
              </span>
              <span className="panel-item-text">{item.text}</span>
            </li>
          ),
        )}
      </ul>
    </DS.SidePanel>
  );
}

function ServicesPanel({ fixture, failing, onClose }) {
  const services = fixture['services.get'].services.map((service) =>
    failing && service.id === 'github-project'
      ? {
          ...service,
          health: 'failing',
          detail:
            'Web roadmap · GitHub answered 401: the token lacks read:project · last read 13:42',
        }
      : service,
  );
  return (
    <DS.SidePanel open onClose={onClose} icon="pulse" title="Services">
      <ul className="panel-list">
        {services.map((service) => (
          <li
            key={service.id}
            className={`panel-item ${DS.quiet}`}
            data-proposed={service.id === 'github-project' ? 'service' : undefined}
          >
            {service.id === 'github-project' && <Proposed />}
            <span className="panel-item-head">
              <DS.StatusDot tone={service.health === 'healthy' ? 'ok' : 'error'} />
              <b>{service.name}</b>
              <span
                className="panel-item-age"
                data-failing={service.health === 'failing' ? '' : undefined}
              >
                {service.health}
              </span>
            </span>
            <span className="panel-item-text">{service.detail}</span>
            {service.id === 'github-project' && service.health === 'failing' && (
              <span className="panel-item-text">
                The Ready part of {service.project} is frozen: tasks stay where they were until the
                mirror reads again.
              </span>
            )}
          </li>
        ))}
      </ul>
    </DS.SidePanel>
  );
}

// ---- Shell ----------------------------------------------------------------------------------

/** The fixture as the state under view needs it. */
function projectFor(fixture, id) {
  const project = fixture['config.get'].projects.find((entry) => entry.id === id);
  if (state !== 'mirror-failing') return project;
  return {
    ...project,
    columns: project.columns.map((column) =>
      column.source?.kind === 'mirror'
        ? {
            ...column,
            source: {
              ...column.source,
              health: 'failing',
              error: 'GitHub answered 401: the token lacks read:project',
              readAt: '2026-11-18T13:42:00Z',
            },
          }
        : column,
    ),
  };
}

/** States that show the second project unless the URL names one. */
const ORBIT_STATES = [
  'column-rules',
  'column-actor',
  'column-actor-no-session',
  'drag',
  'drag-off',
  'reorder-failed',
  'order-changed',
  'card-menu',
  'move',
];
const MANUAL_STATES = ['sort-manual', 'drag', 'reorder-failed', 'order-changed', 'card-menu'];
const READY = 'ready-for-dev';
/** The task a state opens in the task view. */
const OPEN = {
  'approval-stale': 'orbit/api#165',
  'approval-stale-quiet': 'orbit/api#160',
  'approval-multi': 'orbit/api#161',
  'approval-rewritten': 'orbit/api#166',
  'approval-uncounted': 'orbit/api#167',
  'qa-carried': 'orbit/api#160',
  'qa-skipped': 'orbit/api#161',
  'operator-turn': 'orbit/api#174',
  'operator-submit': 'orbit/api#174',
  'operator-return': 'orbit/api#174',
  'operator-turn-closed': 'orbit/api#172',
  'task-move': 'orbit/api#211',
  'task-history': 'orbit/api#160',
  'why-checks': 'orbit/api#172',
  'why-review-rule': 'orbit/api#176',
  'why-merge-unknown': 'orbit/api#166',
}[state];
const INITIAL =
  {
    drag: {
      drag: { key: 'orbit/api#205', column: READY, still: true },
      drop: { column: READY, index: 0 },
    },
    'drag-off': { notice: { column: READY, kind: 'hint' } },
    'reorder-failed': {
      notice: {
        column: READY,
        kind: 'failed',
        key: 'orbit/api#201',
        reason: 'The order changed on the board while you dragged.',
      },
    },
    'card-menu': { menu: 'orbit/api#201' },
    move: { moving: { key: 'orbit/api#211', to: READY } },
    'move-mirror': { menu: 'acme/web#436' },
  }[state] ?? {};

function BoardArea({ fixture, now }) {
  const [projectId, setProjectId] = useState(
    (ORBIT_STATES.includes(state) || OPEN || state === 'inbox') && !params.has('project')
      ? 'orbit-api'
      : initialProject,
  );
  const [opened, setOpened] = useState(OPEN ?? null);
  const [panel, setPanel] = useState(
    state === 'inbox' ? 'inbox' : state.startsWith('services') ? 'services' : null,
  );
  const [sorts, setSorts] = useState({});
  const [tasks, setTasks] = useState(state === 'empty' ? [] : fixture['status.get'].tasks);
  const [drag, setDrag] = useState(
    INITIAL.drag
      ? {
          ...INITIAL.drag,
          row: fixture['status.get'].tasks.find((row) => row.key === INITIAL.drag.key),
        }
      : null,
  );
  const [drop, setDrop] = useState(INITIAL.drop ?? null);
  const [notice, setNotice] = useState(INITIAL.notice ?? null);
  const [menu, setMenu] = useState(INITIAL.menu ?? null);
  const [moving, setMoving] = useState(INITIAL.moving ?? null);
  const [moved, setMoved] = useState(null);
  const project = projectFor(fixture, projectId);
  const columnOf = (id) => project.columns.find((column) => column.id === id);
  const rowsOf = (column) =>
    tasks.filter((row) => row.project === projectId && row.column === column.id);
  const initialSort = MANUAL_STATES.includes(state) ? 'manual' : 'entered-asc';

  /** Puts `key` at `index` of its column's manual order and renumbers the column. */
  const place = (columnId, key, index, note) => {
    const order = sortRows(rowsOf(columnOf(columnId)), 'manual').map((row) => row.key);
    const from = order.indexOf(key);
    const target = Math.max(0, Math.min(order.length - 1, from < index ? index - 1 : index));
    if (from === target) return;
    order.splice(from, 1);
    order.splice(target, 0, key);
    setTasks((current) =>
      current.map((row) =>
        order.includes(row.key) ? { ...row, position: order.indexOf(row.key) + 1 } : row,
      ),
    );
    setMoved(note ? { key, note } : null);
  };
  const reorder = (columnId, key, index) => {
    // `?state=reorder-failed`: every reorder comes back, as on a lost request or a conflict.
    if (state === 'reorder-failed')
      setNotice({
        column: columnId,
        kind: 'failed',
        key,
        reason: 'The board did not answer: the request timed out.',
      });
    else place(columnId, key, index);
  };
  // `?state=order-changed`: another viewer moves a card while the column is open.
  useEffect(() => {
    if (state !== 'order-changed') return undefined;
    const timer = setTimeout(() => place(READY, 'orbit/api#205', 0, 'moved by pm-3a1c'), 1500);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const outside = (event) => {
      if (!event.target.closest('.proposed-card-menu, .proposed-card-more')) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);

  const sameDrop = (next) =>
    JSON.stringify({ ...drop, mirror: undefined }) === JSON.stringify(next);
  const view = {
    sorts,
    initialSort,
    setSort: (column, value) => setSorts({ ...sorts, [column]: value }),
    describe: fixture['columns.describe'].projects[projectId].columns,
    backlogFolded: state === 'todo-collapsed',
    helpFor: (column) =>
      column !== helpColumn
        ? null
        : state === 'column-rules'
          ? 'rules'
          : state.startsWith('column-actor')
            ? 'who'
            : null,
    parts: project.columns.filter((column) => column.group === 'todo'),
    watch: project.approvalWatch,
    open: setOpened,
    rowOf: (key) => tasks.find((row) => row.key === key),
    drag,
    drop,
    notice,
    setNotice,
    menu,
    setMenu,
    moving,
    setMoving,
    moved,
    reorder,
    step: (columnId, key, step) => {
      const order = sortRows(rowsOf(columnOf(columnId)), 'manual').map((row) => row.key);
      const from = order.indexOf(key);
      reorder(columnId, key, step < 0 ? from - 1 : from + 2);
    },
    /** A move between Backlog parts: the task enters the end of the part. */
    move: (key, to) => {
      const last = Math.max(0, ...rowsOf(columnOf(to)).map((row) => row.position));
      setTasks((current) =>
        current.map((row) =>
          row.key === key
            ? { ...row, column: to, position: last + 1, columnEnteredAt: fixture.now }
            : row,
        ),
      );
      setMoving(null);
      setMoved({ key, note: 'moved' });
    },
    /** A card can be dragged in the manual order, and out of a part moved by hand. */
    dragStart: (event, row, column, manual) => {
      setMenu(null);
      setNotice(null);
      if (!manual && !manualPart(column)) {
        event.preventDefault();
        setNotice({ column: column.id, kind: 'hint' });
        return;
      }
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.key);
      setDrag({ key: row.key, column: column.id, row });
    },
    dragEnd: () => {
      setDrag(null);
      setDrop(null);
    },
    zone: (column, manual) => ({
      onDragOver: (event) => {
        if (!drag || drag.still) return;
        let next = null;
        if (drag.column === column.id) {
          if (!manual) {
            if (notice?.column !== column.id) setNotice({ column: column.id, kind: 'hint' });
          } else {
            event.preventDefault();
            const cards = [...event.currentTarget.querySelectorAll(':scope > [data-key]')];
            const index = cards.findIndex((card) => {
              const rect = card.getBoundingClientRect();
              return event.clientY < rect.top + rect.height / 2;
            });
            next = { column: column.id, index: index < 0 ? cards.length : index };
          }
        } else if (column.group === 'todo' && columnOf(drag.column).group === 'todo') {
          if (column.source.kind === 'mirror') next = { column: column.id, refused: true };
          else {
            event.preventDefault();
            next = { column: column.id, part: true };
          }
        }
        if (!sameDrop(next))
          setDrop(next ? { ...next, mirror: next.refused ? column : undefined } : null);
      },
      onDrop: (event) => {
        event.preventDefault();
        if (!drag || !drop || drop.column !== column.id) return;
        if (drop.index !== undefined) reorder(column.id, drag.key, drop.index);
        else if (drop.part) setMoving({ key: drag.key, to: column.id });
        setDrag(null);
        setDrop(null);
      },
    }),
  };
  const group = view.parts;
  const grouped = group.length > 1;
  const firstPlain = project.columns.find(
    (column) => column.group !== 'todo' && rowsOf(column).length > 0,
  );
  return (
    <Fragment>
      <div className="board-top">
        <DS.Logo />
        <DS.Tabs
          id="project"
          label="Project"
          tabs={fixture['config.get'].projects.map((entry) => ({
            value: entry.id,
            label: entry.id,
          }))}
          value={projectId}
          onChange={setProjectId}
        />
        <span className="board-tools">
          <DS.IconButton icon="pulse" label="Services" onClick={() => setPanel('services')} />
          <DS.IconButton icon="inbox" label="Inbox" onClick={() => setPanel('inbox')} />
        </span>
      </div>
      <main className="board-main" key={projectId}>
        {grouped && <BacklogGroup columns={group} rowsOf={rowsOf} now={now} view={view} />}
        {project.columns
          .filter((column) => !(grouped && column.group === 'todo'))
          .map((column) => (
            <Column
              key={column.id}
              column={column}
              rows={rowsOf(column)}
              now={now}
              view={view}
              first={column === firstPlain}
            />
          ))}
      </main>
      {opened && view.rowOf(opened)?.project === projectId && (
        <TaskView
          key={opened}
          fixture={fixture}
          taskKey={opened}
          project={project}
          view={view}
          now={now}
          initialTab={state === 'task-history' ? 'history' : 'now'}
          onClose={() => setOpened(null)}
        />
      )}
      {panel === 'inbox' && (
        <InboxPanel fixture={fixture} now={now} onClose={() => setPanel(null)} />
      )}
      {panel === 'services' && (
        <ServicesPanel
          fixture={fixture}
          failing={state === 'services-failing' || state === 'mirror-failing'}
          onClose={() => setPanel(null)}
        />
      )}
    </Fragment>
  );
}

function App({ fixture }) {
  const [preference, setPreference] = useState(initialTheme);
  document.documentElement.dataset.marks = marks;
  const now = Date.parse(fixture.now);
  return (
    <div className="shell">
      <BoardArea fixture={fixture} now={now} />
      <footer className="proto-bar">
        <span className="proto-bar-note">prototype board-v1-2 · {state}</span>
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
