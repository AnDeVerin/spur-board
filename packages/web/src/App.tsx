import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { z } from 'zod';
import type { statusOutputSchema } from '@spur-board/contracts/browser';
import { coordinateStatus, createApi } from './lib/api.ts';
import { connectStream, type StreamState } from './lib/stream.ts';
import { createTheme, type ThemePreference } from './lib/theme.ts';
import { footerVersion } from './lib/version.ts';
import styles from './App.module.css';

const preferences = ['light', 'dark', 'auto'] as const;
export function App() {
  const [status, setStatus] = useState<z.output<typeof statusOutputSchema>>();
  const [readError, setReadError] = useState(false);
  const [stream, setStream] = useState<StreamState>('reconnecting');
  const [preference, setPreference] = useState<ThemePreference>('dark');
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const theme = useRef<ReturnType<typeof createTheme>>(null);
  useEffect(() => {
    theme.current = createTheme({
      storage: () => localStorage,
      media: matchMedia('(prefers-color-scheme: light)'),
      apply: (value, selected) => {
        document.documentElement.dataset.theme = value;
        setPreference(selected);
      },
    });
    const api = createApi();
    const coordinator = coordinateStatus(
      (signal) => api('status.get', {}, { signal }),
      (value, error) => {
        if (value) setStatus(value);
        setReadError(error);
      },
    );
    coordinator.refresh();
    const connection = connectStream({
      state: setStream,
      refresh: () => {
        coordinator.refresh();
      },
    });
    return () => {
      connection.stop();
      coordinator.dispose();
      theme.current?.dispose();
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !controls.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
    };
  }, [open]);
  const version = footerVersion(status);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const menuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
    ];
    const current = items.findIndex((item) => item === document.activeElement);
    let index: number | undefined;
    if (event.key === 'ArrowDown') index = (current + 1) % items.length;
    if (event.key === 'ArrowUp') index = (current + items.length - 1) % items.length;
    if (event.key === 'Home') index = 0;
    if (event.key === 'End') index = items.length - 1;
    if (index !== undefined) {
      event.preventDefault();
      items[index]?.focus();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
    if (event.key === 'Tab') {
      trigger.current?.focus();
      setOpen(false);
    }
  };
  return (
    <div className={styles.shell}>
      <main className={styles.main} aria-label="Board" />
      <footer className={styles.footer} aria-label="Board status">
        <div className={styles.status} aria-live="polite">
          <span>
            {status
              ? `${String(status.tasks.length)} tasks`
              : readError
                ? 'Status unavailable'
                : 'Loading status…'}
          </span>
          {status && (
            <span className={styles.sources}>
              {status.sources.length === 0
                ? 'No sources'
                : status.sources.map((source) => (
                    <span key={source.source}>
                      {source.source}:{' '}
                      {source.blindReason ? 'failed' : source.warmingUp ? 'warming up' : 'healthy'}
                      {source.stale ? ' · stale' : ''}
                    </span>
                  ))}
            </span>
          )}
          {readError && status && <span>Status stale — refresh failed</span>}
          <span>
            Stream: {stream}
            {stream !== 'live' ? ' · stale' : ''}
          </span>
        </div>
        <div className={styles.controls} ref={controls}>
          <button
            ref={trigger}
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls="theme-menu"
            onClick={() => {
              setOpen(!open);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setOpen(true);
              }
            }}
          >
            Theme: {preference}
          </button>
          {open && (
            <div
              ref={menu}
              id="theme-menu"
              className={styles.menu}
              role="menu"
              aria-label="Theme"
              onKeyDown={menuKey}
            >
              {preferences.map((value) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={preference === value}
                  key={value}
                  onClick={() => {
                    theme.current?.set(value);
                    close();
                  }}
                >
                  {value.charAt(0).toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          )}
          {version && <span>{version}</span>}
        </div>
      </footer>
    </div>
  );
}
