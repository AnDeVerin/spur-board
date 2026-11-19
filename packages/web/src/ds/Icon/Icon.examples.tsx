import { quiet } from '../Quiet/Quiet.tsx';
import { Icon, iconNames, type IconName } from './Icon.tsx';

// Where the board draws each glyph; names without a role here are drawn by the card and inbox.
const roles: Partial<Record<IconName, string>> = {
  mark: 'Spur service',
  caret: 'chevron',
  search: 'filter field',
  ticket: 'ticket link',
  pr: 'GitHub service, PR link',
  term: 'Spur session link',
  x: 'close',
  pulse: 'daemon service',
  hash: 'Slack service',
  diamond: 'Jira service',
  sun: 'theme light',
  moon: 'theme dark',
  auto: 'theme auto',
  agent: 'column actor: agent',
  dispatcher: 'column actor: dispatcher',
  mirror: 'column actor: mirror',
  grip: 'drag grip in Manual',
};

function Grid({ background, caption }: { background: string; caption: string }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        background,
        border: '1px solid var(--color-border-default)',
      }}
    >
      <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>{caption}</p>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(var(--size-column), 1fr))',
          gap: 'var(--space-2)',
        }}
      >
        {iconNames.map((name) => (
          <span
            key={name}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}
          >
            <Icon name={name} />
            {roles[name] ? `${name} - ${roles[name]}` : name}
          </span>
        ))}
      </div>
    </div>
  );
}
export function OnBase() {
  return (
    <Grid
      background="var(--color-bg-base)"
      caption="All 26 glyphs on the base background, by prototype name and board role"
    />
  );
}
export function OnElevated() {
  return (
    <Grid
      background="var(--color-bg-elevated)"
      caption="Each glyph keeps its currentColor contrast on the elevated background; in light the panel matches OnBase because elevated equals base there"
    />
  );
}
export function Labeled() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      <Icon name="x" label="Close" />
      named: role img, label Close
    </span>
  );
}
export function InQuiet() {
  return (
    <div
      className={quiet}
      style={{
        display: 'grid',
        gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        border: '1px solid var(--color-border-default)',
      }}
    >
      <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
        Hover this block: the icons brighten with the text; for focus see Quiet / HoverOrFocus
      </p>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          color: 'var(--color-text-tertiary)',
        }}
      >
        <Icon name="pulse" />
        <Icon name="hash" />
        <Icon name="pr" />
        <Icon name="mark" />
        <Icon name="diamond" />
        services polled 4 minutes ago
      </span>
    </div>
  );
}
