import type { ReactNode } from 'react';
import type { IconName } from '../Icon/Icon.tsx';
import { Layer } from '../Scrim/Scrim.tsx';
import styles from './SidePanel.module.css';

export type SidePanelSide = 'right' | 'left';

/**
 * A panel docked to the right (default) or left edge, between the header band and the status
 * bar band, with a scrim over the same band; at the narrow breakpoint it fills the screen.
 * Those bands stay undimmed but are `inert` while it is open, like everything outside it.
 * Controlled: it renders while `open` and calls `onClose` on Close, a scrim click or Escape (the
 * top layer only). Focus moves to Close on open (a field inside with `autoFocus` keeps it), Tab
 * wraps inside, the page does not scroll, and focus returns to the element that opened it.
 *
 * `icon` and `title` lead the header and `title` labels the dialog; `detail` is a secondary
 * label beside it. A `Modal` may open from inside the panel, also in the same render as the
 * panel; the modal is the top layer either way. A panel opened over an open `Modal` is
 * unsupported: it stacks under the modal.
 */
export function SidePanel({
  open,
  onClose,
  side = 'right',
  icon,
  title,
  detail,
  children,
}: {
  open: boolean;
  onClose: () => void;
  side?: SidePanelSide | undefined;
  icon?: IconName | undefined;
  title: ReactNode;
  detail?: ReactNode;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <Layer
      level="panel"
      classNames={styles}
      side={side}
      icon={icon}
      title={title}
      detail={detail}
      onClose={onClose}
    >
      {children}
    </Layer>
  );
}
