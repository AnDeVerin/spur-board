import type { ReactNode } from 'react';
import { Meter, type MeterThresholds } from './Meter.tsx';

// A budget left: less is worse. Disk used: more is worse.
const budget: MeterThresholds = { warn: 0.2, error: 0.05, worse: 'low' };
const disk: MeterThresholds = { warn: 0.8, error: 0.9, worse: 'high' };

// A meter sits next to the key its `name` repeats, in a column-wide flex row.
function Keyed({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        width: 'var(--size-column)',
      }}
    >
      <span style={{ flex: 'none', color: 'var(--color-text-secondary)' }}>{name}</span>
      {children}
    </div>
  );
}
export function Ok() {
  return (
    <Keyed name="Budget">
      <Meter name="Budget" value={4210} limit={5000} thresholds={budget} />
    </Keyed>
  );
}
export function Warning() {
  return (
    <Keyed name="Budget">
      <Meter name="Budget" value={900} limit={5000} thresholds={budget} />
    </Keyed>
  );
}
export function Error() {
  return (
    <Keyed name="Budget">
      <Meter name="Budget" value={150} limit={5000} thresholds={budget} />
    </Keyed>
  );
}
export function Unknown() {
  return (
    <Keyed name="Budget">
      <Meter name="Budget" value={null} limit={5000} />
    </Keyed>
  );
}
export function HighIsWorse() {
  return (
    <Keyed name="Disk">
      <Meter name="Disk" value={92} limit={100} thresholds={disk} />
    </Keyed>
  );
}
