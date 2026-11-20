import { Fragment } from 'react';
import { Chip, Icon, quiet } from '../ds/index.ts';
import {
  approvalState,
  changedTitle,
  NOT_COUNTED,
  plural,
  shortSha,
  type ApprovalState,
} from './approvals.ts';
import type { BoardTask } from './data.ts';
import { TaskSection } from './TaskSection.tsx';
import styles from './TaskApprovals.module.css';

/** What changed since an approval: on the head, the commits and entries, or why not counted. */
function What({ state }: { state: ApprovalState }) {
  const { approval, kind, loud } = state;
  switch (kind) {
    case 'fresh':
      return 'on the head';
    case 'unread':
      return 'not read yet';
    case 'stale': {
      const watched = new Set(approval.watchedAfter ?? []);
      const changed = approval.changedAfter ?? [];
      // Each group says in words whether its entries are watched; the chip tone repeats it. A
      // loud row is not quiet, so its not watched chips take the default tone, not the tertiary
      // ghost, to stay readable on the tint at rest.
      const groups = [true, false]
        .map((isWatched) => ({
          isWatched,
          entries: changed.filter((entry) => watched.has(entry) === isWatched),
        }))
        .filter(({ entries }) => entries.length > 0);
      return (
        <>
          {plural(approval.commitsAfter ?? 0, 'commit')} since
          {groups.length > 0 && ' · changed:'}
          {groups.map(({ isWatched, entries }, index) => (
            <Fragment key={String(isWatched)}>
              {`${index > 0 ? ' ·' : ''} ${isWatched ? 'watched' : 'not watched'} `}
              {entries.map((entry) => (
                <Chip
                  key={entry}
                  tone={isWatched ? 'warn' : loud ? 'default' : 'ghost'}
                  title={changedTitle(isWatched)}
                  wrap
                >
                  {entry}
                </Chip>
              ))}
            </Fragment>
          ))}
        </>
      );
    }
    case 'rewritten':
    case 'uncounted':
      return (
        <>
          <Chip tone={kind === 'rewritten' ? 'warn' : 'ghost'}>not counted</Chip>{' '}
          {NOT_COUNTED[approval.notCounted ?? 'history_rewritten']}
        </>
      );
  }
}

/**
 * The Approvals section: one row per latest approval of every open PR link, in link order, with
 * its reviewer, commit and what changed since; a row asking for a look is tinted and not quiet,
 * so its text reads the same at rest as on hover. With two or more PR links carrying approvals
 * each row starts with its PR ref. None without approvals.
 */
export function TaskApprovals({ links }: { links: BoardTask['links'] }) {
  const prs = links.filter(
    (link) => link.kind === 'pr' && link.state === 'open' && (link.approvals?.length ?? 0) > 0,
  );
  const rows = prs.flatMap((link) =>
    (link.approvals ?? []).map((approval) => ({ ref: link.ref, state: approvalState(approval) })),
  );
  if (rows.length === 0) return null;
  return (
    <TaskSection id="approvals" title="Approvals" count={rows.length}>
      <ul className={styles.list}>
        {rows.map(({ ref, state }) => (
          <li
            key={`${ref} ${state.approval.author}`}
            className={state.loud ? styles.row : `${styles.row ?? ''} ${quiet}`}
            data-loud={state.loud ? '' : undefined}
          >
            <span className={styles.who}>
              {prs.length > 1 && <span className={styles.ref}>{ref}</span>}
              <Icon name="person" />
              <b className={styles.author}>{state.approval.author}</b>
              <code className={styles.sha} title={state.approval.sha}>
                {shortSha(state.approval.sha)}
              </code>
            </span>
            <span className={styles.what}>
              <What state={state} />
            </span>
          </li>
        ))}
      </ul>
    </TaskSection>
  );
}
