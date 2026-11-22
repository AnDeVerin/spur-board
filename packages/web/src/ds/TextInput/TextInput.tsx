import { useRef } from 'react';
import { useFormRowField } from '../FormRow/FormRow.tsx';
import { Icon, type IconName } from '../Icon/Icon.tsx';
import styles from './TextInput.module.css';

/**
 * A controlled single-line field in the TextArea field style, e.g. the header filter. Standalone,
 * `label` becomes its `aria-label`. Inside a FormRow it takes the row's id, `aria-describedby` and
 * `aria-invalid`, the row's label names it and `label` is ignored. `icon` leads the field. A
 * clear action shows while there is a value and the field is enabled; it empties the field and
 * returns focus to it.
 */
export function TextInput({
  value,
  onChange,
  label,
  placeholder,
  icon,
  clearLabel = 'Clear',
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string | undefined;
  icon?: IconName | undefined;
  clearLabel?: string | undefined;
  disabled?: boolean | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const row = useFormRowField();
  const className = [styles.box, disabled ? styles.disabled : undefined].filter(Boolean).join(' ');
  return (
    <div className={className}>
      {icon !== undefined && <Icon name={icon} />}
      <input
        ref={input}
        className={styles.input}
        type="text"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        id={row?.id}
        aria-label={row ? undefined : label}
        aria-describedby={row?.describedBy}
        aria-invalid={row?.invalid || undefined}
        placeholder={placeholder}
        disabled={disabled}
      />
      {value !== '' && !disabled && (
        <button
          className={styles.clear}
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={() => {
            onChange('');
            input.current?.focus();
          }}
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}
