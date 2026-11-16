import type { ReactNode } from 'react';
import { Layer } from '../Scrim/Scrim.tsx';
import styles from './Modal.module.css';

/**
 * A dialog centred over the whole screen with its own scrim, above any open side panel; at the
 * narrow breakpoint it fills the screen. Controlled: it renders while `open` and calls `onClose`
 * on Close, a scrim click or Escape (the top layer only). Focus moves to Close on open, Tab wraps
 * inside, everything outside is `inert`, the page does not scroll, and focus returns to the
 * element that opened it.
 *
 * `title` labels the dialog; `detail` is a secondary label beside it.
 * `actions` sits in the header before Close, e.g. an underline `Tabs`. Keep it narrow. At 390px
 * the header row holds the title, the detail, `actions` and Close; `actions` does not shrink, and
 * the title and detail ellipsize first; content wider than about 200px pushes the title to
 * nothing.
 *
 * A modal may open over a `SidePanel`; a `SidePanel` opened over an open modal is unsupported.
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
    <Layer classNames={styles} title={title} detail={detail} actions={actions} onClose={onClose}>
      {children}
    </Layer>
  );
}
