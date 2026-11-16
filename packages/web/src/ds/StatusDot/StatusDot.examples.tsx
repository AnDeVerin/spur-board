import { StatusDot } from './StatusDot.tsx';

export function Ok() {
  return <StatusDot tone="ok" />;
}
export function Warn() {
  return <StatusDot tone="warn" />;
}
export function Error() {
  return <StatusDot tone="error" />;
}
export function Unknown() {
  return <StatusDot tone="unknown" />;
}
export function Hollow() {
  return <StatusDot tone="warn" hollow />;
}
