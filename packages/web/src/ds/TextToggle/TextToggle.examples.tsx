import { useState } from 'react';
import { TextToggle } from './TextToggle.tsx';

const noop = () => undefined;

export function Rest() {
  return <TextToggle onClick={noop}>… Show all · 2 replies</TextToggle>;
}
export function Focused() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', justifyItems: 'start' }}>
      <p style={{ margin: 0, color: 'var(--color-text-tertiary)' }}>
        Press Tab to reach the toggle; Enter or Space toggles it
      </p>
      <TextToggle
        expanded={expanded}
        caret
        onClick={() => {
          setExpanded(!expanded);
        }}
      >
        {expanded ? 'Collapse' : '… Show all'}
      </TextToggle>
    </div>
  );
}
export function Expanded() {
  const [expanded, setExpanded] = useState(true);
  return (
    <TextToggle
      expanded={expanded}
      caret
      onClick={() => {
        setExpanded(!expanded);
      }}
    >
      {expanded ? 'Collapse B161' : '… Show all'}
    </TextToggle>
  );
}
