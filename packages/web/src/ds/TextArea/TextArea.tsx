import { useFormRowField } from '../FormRow/FormRow.tsx';
import styles from './TextArea.module.css';

/**
 * A controlled multi-line field. Inside a FormRow it takes the row's id, `aria-describedby` and
 * `aria-invalid`, and the row's label names it. Standalone it needs `label`, which becomes its
 * `aria-label`; inside a row `label` is ignored.
 */
export function TextArea({
  value,
  onChange,
  placeholder,
  disabled = false,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  label?: string | undefined;
}) {
  const row = useFormRowField();
  return (
    <textarea
      className={styles.field}
      value={value}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      placeholder={placeholder}
      disabled={disabled}
      id={row?.id}
      aria-label={row ? undefined : label}
      aria-describedby={row?.describedBy}
      aria-invalid={row?.invalid || undefined}
    />
  );
}
