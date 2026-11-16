import { Icon } from '../Icon/Icon.tsx';
import { Logo } from './Logo.tsx';

const row = { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' } as const;

export function Header() {
  return (
    <span style={row}>
      <Logo label="spur-board" />
      header size, named spur-board: label it only where no visible product name sits next to it
    </span>
  );
}
export function Small() {
  return (
    <span style={row}>
      <Logo size="small" />
      small logo next to the mark icon at the same size
      <Icon name="mark" />
    </span>
  );
}
