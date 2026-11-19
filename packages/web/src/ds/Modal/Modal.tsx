import type { ReactNode } from 'react';
import { Layer } from '../Scrim/Scrim.tsx';
import styles from './Modal.module.css';

/**
 * A dialog centred over the whole screen with its own scrim, above any open side panel; at the
 * narrow breakpoint it fills the screen. Controlled: it renders while `open` and calls `onClose`
 * on Close, a scrim click or Escape (the top layer only). Focus moves to Close on open (a field
 * inside with `autoFocus` keeps it), Tab wraps inside, everything outside is `inert`, the page
 * does not scroll, and focus returns to the element that opened it.
 *
 * `title` labels the dialog; `detail` is a secondary label beside it.
 * `actions` sits at the right of the header, right before Close, e.g. an underline `Tabs`; the
 * free space of the row lies between the detail and `actions`. Keep it narrow. At 375px the
 * header stays one row and nothing wraps: `actions` and Close keep their width, the free space
 * goes first, then the detail and the title ellipsize. With the 122px Now and History tabs the
 * title and detail share about 180px.
 *
 * Design system decision (board V1.2, operator session 2026-11-18): actions sit at the right of
 * the header, before Close (was: after the detail).
 *
 * A modal may open over a `SidePanel`, also in the same render as a panel it is nested in (a deep
 * link): it is the top layer either way. A `SidePanel` opened over an open modal is unsupported:
 * it stacks under the modal.
 */
export function Modal({
  open,
  onClose,
  title,
  detail,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  detail?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <Layer
      level="modal"
      classNames={styles}
      title={title}
      detail={detail}
      actions={actions}
      onClose={onClose}
    >
      {children}
    </Layer>
  );
}
