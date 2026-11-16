import { useState } from 'react';
import { Button } from '../Button/Button.tsx';
import { Scrim } from './Scrim.tsx';

export function Default() {
  const [shown, setShown] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Show the scrim: it dims only the box below; a click on it hides it, as does the button.
      </p>
      <Button
        onClick={() => {
          setShown(!shown);
        }}
      >
        {shown ? 'Hide scrim' : 'Show scrim'}
      </Button>
      <div
        style={{
          position: 'relative',
          justifySelf: 'stretch',
          maxWidth: 'var(--size-panel)',
          padding: 'var(--space-4)',
          boxSizing: 'border-box',
          border: 'var(--size-hairline) solid var(--color-border-default)',
        }}
      >
        <p style={{ margin: 0 }}>Board content behind the scrim.</p>
        {shown && (
          <Scrim
            onClick={() => {
              setShown(false);
            }}
          />
        )}
      </div>
    </div>
  );
}
