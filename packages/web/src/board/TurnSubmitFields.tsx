import type { ReactNode } from 'react';
import { FormRow, TabPanel, Tabs, TextInput } from '../ds/index.ts';
import {
  BASES,
  BASIS_ID,
  isBasis,
  NO_COMMIT_REASON_HINT,
  NO_PR_COMMIT_HINT,
  type Basis,
  type FieldErrors,
} from './turn-model.ts';
import styles from './TaskTurn.module.css';

/**
 * The fields of the Turn section's submit form: Commit, then the Basis tabs with their fields.
 * Where the commit may be omitted (`optional`) and it is empty, a required Reason replaces Basis:
 * a submit without a commit. The section owns the values and the Reason row.
 */
export function TurnSubmitFields({
  commit,
  optional,
  basis,
  from,
  errors,
  disabled,
  onCommit,
  onBasis,
  onFrom,
  reasonRow,
}: {
  commit: string;
  optional: boolean;
  basis: Basis;
  from: string;
  errors: FieldErrors;
  disabled: boolean;
  onCommit: (text: string) => void;
  onBasis: (basis: Basis) => void;
  onFrom: (text: string) => void;
  /** The Reason row with the given hint. */
  reasonRow: (hint: string) => ReactNode;
}) {
  return (
    <>
      <FormRow
        label="Commit"
        hint={optional ? NO_PR_COMMIT_HINT : 'The head of the PR unless you tested another commit.'}
        error={errors.sha}
      >
        <TextInput value={commit} onChange={onCommit} label="Commit" disabled={disabled} />
      </FormRow>
      {optional && commit.trim() === '' ? (
        reasonRow(NO_COMMIT_REASON_HINT)
      ) : (
        <>
          <Tabs
            id={BASIS_ID}
            label="Basis"
            tabs={BASES}
            value={basis}
            disabled={disabled}
            onChange={(chosen) => {
              if (isBasis(chosen)) onBasis(chosen);
            }}
          />
          <TabPanel tabsId={BASIS_ID} value={basis}>
            {basis === 'tested' ? (
              <p className={styles.note}>
                Tested on the commit above. No source or reason is needed.
              </p>
            ) : (
              <div className={styles.fields}>
                {basis === 'carried' && (
                  <FormRow
                    label="Carried from"
                    hint="A commit of this task with a tested submit."
                    error={errors.from}
                  >
                    <TextInput
                      value={from}
                      onChange={onFrom}
                      label="Carried from"
                      disabled={disabled}
                    />
                  </FormRow>
                )}
                {reasonRow('Required. Shown on the card and in the history.')}
              </div>
            )}
          </TabPanel>
        </>
      )}
    </>
  );
}
