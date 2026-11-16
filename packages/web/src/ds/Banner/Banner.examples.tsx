import { Button } from '../Button/Button.tsx';
import { Banner } from './Banner.tsx';

const retry = <Button>Retry now</Button>;

export function Error() {
  return (
    <Banner variant="error" icon="x" detail="Retrying in 12 s">
      The daemon does not answer
    </Banner>
  );
}
export function ErrorWithAction() {
  return (
    <Banner variant="error" icon="x" detail="Retrying in 12 s" action={retry}>
      The daemon does not answer
    </Banner>
  );
}
export function Warning() {
  return (
    <Banner variant="warning" icon="clock" detail="Last poll 6 minutes ago">
      The board is offline: data may be stale
    </Banner>
  );
}
export function WarningWithAction() {
  return (
    <Banner variant="warning" icon="clock" detail="Last poll 6 minutes ago" action={retry}>
      The board is offline: data may be stale
    </Banner>
  );
}
export function Info() {
  return (
    <Banner variant="info" icon="shadow" detail="Changes are not sent anywhere">
      Shadow mode
    </Banner>
  );
}
export function InfoWithAction() {
  return (
    <Banner
      variant="info"
      icon="shadow"
      detail="Changes are not sent anywhere"
      action={<Button>Leave shadow mode</Button>}
    >
      Shadow mode
    </Banner>
  );
}
export function LongText() {
  return (
    <div style={{ maxWidth: 'var(--size-column)' }}>
      <Banner
        variant="error"
        icon="x"
        detail="The last answer came from the daemon on a different port; check the configuration"
        action={retry}
      >
        The daemon does not answer, and the board cannot load tasks, sources or the inbox
      </Banner>
    </div>
  );
}
