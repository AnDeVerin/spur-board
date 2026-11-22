import { quiet } from '../Quiet/Quiet.tsx';
import { Skeleton } from './Skeleton.tsx';

export function Card() {
  return <Skeleton />;
}
export function Widths() {
  return <Skeleton widths={[45, 100, 85, 60]} />;
}
export function Column() {
  return (
    <div
      className={quiet}
      style={{ display: 'grid', gap: 'var(--space-2)', maxWidth: 'var(--size-column)' }}
    >
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Turn on reduced motion to stop the pulse
      </p>
      <Skeleton />
      <Skeleton />
      <Skeleton />
    </div>
  );
}
