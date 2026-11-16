import { Chip } from './Chip.tsx';

export function Default() {
  return <Chip>healthy</Chip>;
}
export function Warn() {
  return <Chip tone="warn">stale</Chip>;
}
export function You() {
  return <Chip tone="you">you</Chip>;
}
export function Ghost() {
  return <Chip tone="ghost">no owner</Chip>;
}
