import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BoardTask } from './data.ts';
import { REREAD_LIMIT_MS } from './turn-model.ts';

/**
 * The re-read after a take or a close of the Turn section: `pending` while it runs, `failed` when
 * it failed or outlasted `REREAD_LIMIT_MS`. Either way the section names no holder and sends
 * nothing. Only the keyed re-read clears it by answering; once that re-read settled, any later
 * read was issued after the write, so a newer `value` clears a failure too. A read issued before
 * the write that answers after the deadline does not. `line` goes on the
 * plain line shown then: when that line goes away while it has focus, focus moves to the first
 * enabled button `actions` holds, else to the button of the section `section` sits in.
 */
export function useTurnReread(
  value: BoardTask,
  actions: () => HTMLElement | null,
  section: () => HTMLElement | null,
) {
  const [reread, setReread] = useState<'pending' | 'failed'>();
  // The keyed re-read of the latest write answered, well or not.
  const settled = useRef(true);
  useEffect(() => {
    if (settled.current) setReread((current) => (current === 'failed' ? undefined : current));
  }, [value]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Numbers each re-read, so an older one's deadline or answer never settles a newer one.
  const seq = useRef(0);
  const ref = useRef<HTMLParagraphElement>(null);
  const focused = useRef(false);
  const stale = reread !== undefined;
  useLayoutEffect(() => {
    if (stale || !focused.current) return;
    focused.current = false;
    const first = [...(actions()?.querySelectorAll('button') ?? [])].find(
      (button) => !button.disabled,
    );
    (first ?? section()?.closest('section')?.querySelector('button'))?.focus();
  }, [stale, actions, section]);
  return {
    reread,
    /** Track the re-read the write started. */
    watch: (refresh: Promise<boolean>) => {
      const own = ++seq.current;
      const settle = (next: 'failed' | undefined) => {
        if (mounted.current && own === seq.current) setReread(next);
      };
      settled.current = false;
      setReread('pending');
      const deadline = setTimeout(() => {
        settle('failed');
      }, REREAD_LIMIT_MS);
      void refresh.then((read) => {
        clearTimeout(deadline);
        if (own === seq.current) settled.current = true;
        settle(read ? undefined : 'failed');
      });
    },
    /** Props of the plain line: its ref and the focus it reports. */
    line: {
      ref,
      onFocus: () => {
        focused.current = true;
      },
      onBlur: () => {
        focused.current = false;
      },
    },
  };
}
