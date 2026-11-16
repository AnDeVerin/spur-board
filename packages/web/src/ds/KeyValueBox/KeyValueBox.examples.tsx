import { Meter } from '../Meter/Meter.tsx';
import { quiet } from '../Quiet/Quiet.tsx';
import { KeyValueBox } from './KeyValueBox.tsx';

// Screens put the box in a quiet container, so the muted rows brighten on hover or focus.
export function AllStates() {
  return (
    <div className={quiet}>
      <KeyValueBox
        rows={[
          { key: 'PR open', value: 'met', status: 'pass' },
          { key: 'Checks green', value: 'checks pending', status: 'wait' },
          { key: 'Review approved', value: 'changes requested', status: 'fail' },
          { key: 'Merged', status: 'unchecked' },
          { key: 'No PR found for the task branch', status: 'fail' },
          { key: 'Open turn', value: 'none' },
        ]}
      />
    </div>
  );
}
// The wrapper cancels the gallery's own wrapping, so only the component's CSS wraps the text.
export function LongText() {
  return (
    <div style={{ overflowWrap: 'normal', width: 'var(--size-column)' }}>
      <KeyValueBox
        rows={[
          {
            key: 'A long condition name that needs more than one line to fit the column',
            value: 'waiting for the reviewer to come back from a long holiday',
            status: 'wait',
          },
          {
            key: 'Branch',
            value: 'claude-554-a-branch-name-without-any-break-opportunity-at-all',
          },
        ]}
      />
    </div>
  );
}
export function Titled() {
  return (
    <div className={quiet}>
      <KeyValueBox
        title="github pull requests"
        rows={[
          { key: 'Last poll', value: '2 minutes ago' },
          { key: 'Budget', value: <Meter name="Budget" value={4210} limit={5000} /> },
          { key: 'CPU', value: '—' },
          { key: 'Host under load', status: 'wait' },
          { key: 'Spur unavailable: Spur daemon did not answer', status: 'fail' },
        ]}
      />
    </div>
  );
}
