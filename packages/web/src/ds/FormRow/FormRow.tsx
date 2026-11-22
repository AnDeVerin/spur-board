import { createContext, useContext, useId, type ReactNode } from 'react';
import styles from './FormRow.module.css';

interface FormRowField {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}
const FieldContext = createContext<FormRowField | undefined>(undefined);

/** The field wiring of the enclosing FormRow, or `undefined` outside a row. */
export function useFormRowField(): FormRowField | undefined {
  return useContext(FieldContext);
}

/**
 * A labelled field row: label, the field, a hint or an error line, then the actions. The field
 * inside (a TextArea or TextInput) takes its id and `aria-describedby` from the row. An `error`
 * replaces the hint and never touches the field's value. The row is a `div`; the screen owns the
 * `<form>`.
 */
export function FormRow({
  label,
  hint,
  error,
  actions,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const invalid = error !== undefined;
  const note = invalid ? error : hint;
  const field = { id, describedBy: note === undefined ? undefined : noteId, invalid };
  return (
    <div className={styles.row}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <FieldContext value={field}>{children}</FieldContext>
      {invalid ? (
        <p className={styles.error} id={noteId} role="alert">
          {error}
        </p>
      ) : (
        note !== undefined && (
          <p className={styles.hint} id={noteId}>
            {note}
          </p>
        )
      )}
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
