// The task card as data: what a `status.get` row shows on the board, before any markup.
import type { ChipTone, IconName, StatusDotTone } from '../ds/index.ts';
import { safeExternalUrl, sessionLinkHref, ticketBrowseHref } from '../lib/links.ts';
import { formatDataTime, type BoardRow } from './model.ts';

type Turn = NonNullable<BoardRow['turn']>;
type PrSummary = NonNullable<BoardRow['prSummary']>[number];
type PrLink = BoardRow['links']['prs'][number];

/**
 * The PR the card shows: the first linked one, the PR quick link opens, and its summary, matched
 * by number and by repo ignoring case, as `status.get` joins repos. Every PR fact on the card
 * comes from this summary; null when that PR is not observed yet.
 */
function displayedPr(row: BoardRow): { link: PrLink; summary: PrSummary | null } | null {
  const link = row.links.prs[0];
  if (link === undefined) return null;
  const repo = link.repo.toLowerCase();
  const summary = row.prSummary?.find(
    (candidate) => candidate.number === link.number && candidate.repo.toLowerCase() === repo,
  );
  return { link, summary: summary ?? null };
}

/** `agent:<project>/<session>` reads as the session; any other actor stays as it is. */
const actorName = (actor: string) =>
  actor.startsWith('agent:') ? actor.slice(actor.indexOf('/') + 1) : actor;

/**
 * Time from `fromIso` to `now`: `Nm` under an hour, `Hh` or `Hh Mm` under a day, else `Nd`. A
 * future time reads `0m`; with no `now` (no good read yet) the age is `—`.
 */
export function age(fromIso: string, now: number | undefined): string {
  if (now === undefined) return '—';
  const minutes = Math.max(0, Math.round((now - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  if (minutes < 1440) {
    const hours = `${String(Math.floor(minutes / 60))}h`;
    return minutes % 60 === 0 ? hours : `${hours} ${String(minutes % 60)}m`;
  }
  return `${String(Math.floor(minutes / 1440))}d`;
}

/** Who holds the turn: agent (taken), you (the operator), wait (not taken), stall, or none. */
type TurnKind = 'agent' | 'you' | 'wait' | 'stall' | 'none';

export interface TurnView {
  kind: Exclude<TurnKind, 'none'>;
  id: string;
  /** The addressee role, such as `worker` or `orchestrator`; unused for your turn. */
  role: string;
  /**
   * The session that took the turn, else the one it is addressed to, else `unassigned`; unused
   * for your turn.
   */
  name: string;
  /** `taken · 5m` (an agent's, or yours once you hold it), `open · 2h`, `not taken · 1d` or `stalled · 40m`. */
  tail: string;
  tone: StatusDotTone;
  hollow: boolean;
}

/** The turn line; null when no turn is open. */
export function turnView(turn: Turn | null, now: number | undefined): TurnView | null {
  if (turn === null) return null;
  const common = {
    id: turn.id,
    role: turn.addressee.split(':')[0] ?? turn.addressee,
    name: turn.taken === null ? (turn.addressedTo ?? 'unassigned') : actorName(turn.taken.by),
  };
  if (turn.stalledSince !== null)
    return {
      ...common,
      kind: 'stall',
      tail: `stalled · ${age(turn.stalledSince, now)}`,
      tone: 'error',
      hollow: false,
    };
  // Your turn: addressed to the operator and untaken or held by the operator token. An operator
  // session that holds it reads like an agent's.
  if (turn.addressee === 'operator' && (turn.taken === null || turn.taken.by === 'operator'))
    return {
      ...common,
      kind: 'you',
      tail:
        turn.taken === null ? `open · ${age(turn.at, now)}` : `taken · ${age(turn.taken.at, now)}`,
      tone: 'warn',
      hollow: false,
    };
  if (turn.taken !== null)
    return {
      ...common,
      kind: 'agent',
      tail: `taken · ${age(turn.taken.at, now)}`,
      tone: 'working',
      hollow: false,
    };
  return {
    ...common,
    kind: 'wait',
    tail: `not taken · ${age(turn.at, now)}`,
    tone: 'warn',
    hollow: true,
  };
}

/** One chip in the markers row. */
export interface Marker {
  tone: ChipTone;
  icon?: IconName;
  text: string;
  title?: string;
}

/** The operator's first open block as `B<n> → you`, the rest as `+N`; agent blocks as a count. */
export function blockMarkers(blocks: BoardRow['blocks']): Marker[] {
  const mine = blocks.find(({ addressee }) => addressee === 'operator');
  const rest = blocks.filter((block) => block !== mine).map(({ id }) => id);
  if (mine !== undefined)
    return [
      { tone: 'you', icon: 'block', text: `${mine.id} → you` },
      ...(rest.length === 0
        ? []
        : [
            {
              tone: 'error' as const,
              icon: 'block' as const,
              text: `+${String(rest.length)}`,
              title: `Other open blocks: ${rest.join(', ')}`,
            },
          ]),
    ];
  if (rest.length === 0) return [];
  return [
    {
      tone: 'error',
      icon: 'block',
      text: `${String(rest.length)} ${rest.length === 1 ? 'block' : 'blocks'}`,
      title: `Open blocks: ${rest.join(', ')}`,
    },
  ];
}

/** `returned`, with ` · N findings` when the return counted them. */
export function returnedMarker(returned: BoardRow['returned']): Marker | null {
  if (returned === undefined) return null;
  return {
    tone: 'warn',
    icon: 'back',
    text:
      returned.findings === null ? 'returned' : `returned · ${String(returned.findings)} findings`,
    title: `Returned from ${returned.from} by ${actorName(returned.by)} at ${formatDataTime(
      Date.parse(returned.at),
    )}, block ${returned.block}`,
  };
}

/** In shadow mode, where the board would have the task when that differs from the tracker. */
function shadowMarker(row: BoardRow): Marker | null {
  if (row.shadowDiffers !== true || row.shadowColumn === undefined) return null;
  return {
    tone: 'ghost',
    icon: 'shadow',
    text: `board: ${row.shadowColumn} · tracker: ${row.column}`,
  };
}

/**
 * In Ready to Merge, the QA column's latest submission when it was not tested: `QA carried` with
 * the source commit and reason, or a warn `QA skipped` with the reason. A pending row counts by
 * its basis; a voided one gives nothing.
 */
export function qaMarker(row: BoardRow): Marker | null {
  const qa = row.qaSubmission;
  if (row.column !== 'ready-to-merge' || qa === undefined || qa === null || qa.voided) return null;
  const reason = qa.reason === null ? '' : `: ${qa.reason}`;
  if (qa.basis === 'carried')
    return {
      tone: 'default',
      text: 'QA carried',
      title: `Verdict carried${qa.from === null ? '' : ` from ${qa.from}`}${reason}`,
    };
  if (qa.basis === 'skipped')
    return { tone: 'warn', text: 'QA skipped', title: `QA skipped${reason}` };
  return null;
}

/** A session id longer than this is cut, with the full id in the tooltip. */
const SESSION_CHARS = 20;

const sessionUrl = (row: BoardRow, spurUiOrigin: string | null) => {
  const session = row.links.sessions[0];
  return session === undefined ? null : sessionLinkHref(spurUiOrigin, session.id);
};

/** The session as a plain chip when it has no link: no Spur UI origin, or an unsafe URL. */
export function sessionChip(row: BoardRow, spurUiOrigin: string | null): Marker | null {
  const session = row.links.sessions[0];
  if (session === undefined || sessionUrl(row, spurUiOrigin) !== null) return null;
  const id =
    session.id.length > SESSION_CHARS ? `${session.id.slice(0, SESSION_CHARS - 1)}…` : session.id;
  return {
    tone: 'default',
    icon: 'term',
    text: `session ${id}`,
    title: `Spur session ${session.id}`,
  };
}

/** Every marker in drawing order: QA, blocks, returned, draft, shadow, then the session chip. */
export function markers(row: BoardRow, spurUiOrigin: string | null): Marker[] {
  const draft: Marker | null =
    displayedPr(row)?.summary?.draft === true ? { tone: 'default', text: 'draft' } : null;
  return [
    qaMarker(row),
    ...blockMarkers(row.blocks),
    returnedMarker(row.returned),
    draft,
    shadowMarker(row),
    sessionChip(row, spurUiOrigin),
  ].filter((marker): marker is Marker => marker !== null);
}

/** `ok` is muted with a green glyph; `neutral` reports nothing or an unconfirmed fact. */
type CellTone = 'ok' | 'bad' | 'pend' | 'neutral';

interface PrCell {
  tone: CellTone;
  label: string;
  icons: IconName[];
  text: string;
}

export type PrStatus =
  | { kind: 'none' }
  /** A turn is open and no PR is linked yet. */
  | { kind: 'placeholder' }
  /** The first linked PR is not observed yet. */
  | { kind: 'unobserved'; more: MorePrs }
  | {
      kind: 'cells';
      cells: [PrCell, PrCell, PrCell, PrCell];
      unconfirmed: boolean;
      more: MorePrs;
    };

/** The linked PRs after the first one, observed or not; null when there are none. */
type MorePrs = { count: number; title: string } | null;

const NONE = '–';

const MERGE: Record<PrSummary['mergeable'], PrCell> = {
  mergeable: { tone: 'ok', label: 'Merge: no conflicts', icons: ['merge'], text: '' },
  conflicting: { tone: 'bad', label: 'Merge: conflicting', icons: ['merge', 'x'], text: '' },
  unknown: { tone: 'neutral', label: 'Merge: mergeability unknown', icons: ['merge'], text: '?' },
};

function prCells(pr: PrSummary): [PrCell, PrCell, PrCell, PrCell] {
  const { pass, fail, pending } = pr.checks;
  const total = pass + fail + pending;
  const checks: PrCell =
    total === 0
      ? { tone: 'neutral', label: 'Checks: none reported', icons: ['check'], text: NONE }
      : {
          tone: fail > 0 ? 'bad' : pending > 0 ? 'pend' : 'ok',
          label: `Checks: ${String(pass)} of ${String(total)} passed${
            fail > 0 ? `, ${String(fail)} failed` : ''
          }${pending > 0 ? `, ${String(pending)} pending` : ''}`,
          icons: [fail > 0 ? 'x' : pending > 0 ? 'clock' : 'check'],
          text: `${String(pass)}/${String(total)}`,
        };
  const merge = MERGE[pr.mergeable];
  const { unresolved, total: threadTotal } = pr.threads;
  const resolved = String(threadTotal - unresolved);
  const threads: PrCell =
    threadTotal === 0
      ? { tone: 'neutral', label: 'Threads: none', icons: ['bubble'], text: NONE }
      : {
          tone: unresolved > 0 ? 'pend' : 'ok',
          label: `Threads: ${resolved} of ${String(threadTotal)} resolved`,
          icons: ['bubble'],
          text: `${resolved}/${String(threadTotal)}`,
        };
  const { approved, changesRequested } = pr.reviewsOnHead;
  const reviews: PrCell =
    changesRequested.length > 0
      ? {
          tone: 'bad',
          label: `Reviews on the head: ${String(changesRequested.length)} changes requested`,
          icons: ['person'],
          text: String(changesRequested.length),
        }
      : approved.length > 0
        ? {
            tone: 'ok',
            label: `Reviews on the head: ${String(approved.length)} approved`,
            icons: ['person'],
            text: String(approved.length),
          }
        : { tone: 'neutral', label: 'Reviews on the head: none', icons: ['person'], text: NONE };
  const cells: [PrCell, PrCell, PrCell, PrCell] = [checks, merge, threads, reviews];
  if (!pr.unconfirmed) return cells;
  return cells.map((cell) => ({
    ...cell,
    tone: 'neutral' as const,
    label: `${cell.label}, not confirmed`,
  })) as [PrCell, PrCell, PrCell, PrCell];
}

/**
 * PR status of the first linked PR, the one the PR quick link opens: its summary's cells, or the
 * not-observed cells, with `+N` for the other linked PRs.
 */
export function prStatus(row: BoardRow): PrStatus {
  const shown = displayedPr(row);
  if (shown === null) return { kind: row.turn === null ? 'none' : 'placeholder' };
  const rest = row.links.prs.slice(1);
  const more: MorePrs =
    rest.length === 0
      ? null
      : {
          count: rest.length,
          title: `${String(rest.length)} more pull request${rest.length === 1 ? '' : 's'}: ${rest
            .map(({ number }) => `#${String(number)}`)
            .join(', ')}`,
        };
  const { summary } = shown;
  if (summary === null) return { kind: 'unobserved', more };
  return { kind: 'cells', cells: prCells(summary), unconfirmed: summary.unconfirmed, more };
}

/** A link beside the card that opens in a new tab. */
export interface QuickLink {
  kind: 'ticket' | 'pr' | 'session';
  icon: IconName;
  href: string;
  label: string;
  title: string;
}

/**
 * Ticket, PR and Spur session links; a missing or unsafe URL drops its link. A Jira key links to
 * `<ticketBrowseBase><key>` (`config.get` `projects[].ticketBrowseBase`) before the observed URL.
 */
export function quickLinks(
  row: BoardRow,
  spurUiOrigin: string | null,
  ticketBrowseBase: string | null,
): QuickLink[] {
  const list: QuickLink[] = [];
  const jira = ticketBrowseHref(ticketBrowseBase, row.key);
  const ticket = jira ?? (row.links.ticket === null ? null : safeExternalUrl(row.links.ticket));
  if (ticket !== null)
    list.push({
      kind: 'ticket',
      icon: 'ticket',
      href: ticket,
      label: `Ticket ${row.key}, ${jira === null ? '' : 'Jira, '}opens in a new tab`,
      title: `Ticket ${row.key}: ${ticket}`,
    });
  const pr = row.links.prs[0];
  const prUrl = pr === undefined ? null : safeExternalUrl(pr.url);
  if (pr !== undefined && prUrl !== null)
    list.push({
      kind: 'pr',
      icon: 'pr',
      href: prUrl,
      label: `PR #${String(pr.number)}, opens in a new tab`,
      title: `PR #${String(pr.number)}: ${prUrl}`,
    });
  const session = row.links.sessions[0];
  const spur = sessionUrl(row, spurUiOrigin);
  if (session !== undefined && spur !== null)
    list.push({
      kind: 'session',
      icon: 'term',
      href: spur,
      label: `Spur session ${session.id}, opens in a new tab`,
      title: `Spur session ${session.id}`,
    });
  return list;
}
