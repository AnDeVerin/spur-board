import { useState } from 'react';
import { Button } from '../Button/Button.tsx';
import { IconButton } from '../IconButton/IconButton.tsx';
import { TextArea } from '../TextArea/TextArea.tsx';
import { FormRow } from './FormRow.tsx';

const hint = 'The agent reads it on its next turn';
const notSent = 'Not sent: the daemon did not answer. Your text is kept here.';
const draft = 'Use the staging database for the migration test';

function Row({
  initial = '',
  error,
  busy = false,
  disabled = false,
  rowHint = hint,
  send = 'Answer B89',
}: {
  initial?: string;
  error?: string;
  busy?: boolean;
  disabled?: boolean;
  rowHint?: string;
  send?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <FormRow
      label="Answer B89"
      hint={rowHint}
      error={error}
      actions={
        <>
          <Button variant="primary" busy={busy} disabled={disabled}>
            {send}
          </Button>
          <IconButton icon="x" size="control" label="Cancel" disabled={disabled} />
        </>
      }
    >
      <TextArea
        value={value}
        onChange={setValue}
        placeholder="Your answer goes to the agent"
        disabled={disabled}
      />
    </FormRow>
  );
}
export function Answer() {
  return <Row />;
}
export function Error() {
  return <Row initial={draft} error={notSent} send="Send again" />;
}
export function Sending() {
  return <Row initial={draft} busy send="Sending" />;
}
export function Disabled() {
  return <Row disabled rowHint="Answers cannot be sent while the daemon does not answer" />;
}
export function SendFails() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError(notSent);
      }}
    >
      <FormRow
        label="Answer B89"
        hint="Type, then press Send: this demo never reaches the daemon"
        error={error}
        actions={
          <>
            <Button variant="primary" type="submit">
              {error === undefined ? 'Answer B89' : 'Send again'}
            </Button>
            <IconButton
              icon="x"
              size="control"
              label="Cancel"
              onClick={() => {
                setValue('');
                setError(undefined);
              }}
            />
          </>
        }
      >
        <TextArea value={value} onChange={setValue} placeholder="Your answer goes to the agent" />
      </FormRow>
    </form>
  );
}
export function NarrowActions() {
  return (
    <div style={{ width: 'calc(var(--size-control) * 6)' }}>
      <Row initial={draft} send="Send follow-up" />
    </div>
  );
}
