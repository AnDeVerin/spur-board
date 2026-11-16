import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { statusOutputSchema } from '@spur-board/contracts/browser';
import { coordinateStatus, createApi } from './lib/api.ts';
import { connectStream, type StreamState } from './lib/stream.ts';
import { createTheme, type ThemePreference } from './lib/theme.ts';
import { Chip, StatusDot, ThemeSwitch, type StatusDotTone } from './ds/index.ts';
import { footerVersion } from './lib/version.ts';
import styles from './App.module.css';

const streamTone: Record<StreamState, StatusDotTone> = {
  live: 'ok',
  reconnecting: 'warn',
  offline: 'error',
};
const stale = (
  <>
    {' '}
    <Chip tone="warn">stale</Chip>
  </>
);
export function App() {
  const [status, setStatus] = useState<z.output<typeof statusOutputSchema>>();
  const [readError, setReadError] = useState(false);
  const [stream, setStream] = useState<StreamState>('reconnecting');
  const [preference, setPreference] = useState<ThemePreference>('dark');
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
  const version = footerVersion(status);
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
                    <span key={source.source} className={styles.item}>
                      <StatusDot
                        tone={source.blindReason ? 'error' : source.warmingUp ? 'warn' : 'ok'}
                      />
                      {source.source}:{' '}
                      {source.blindReason ? 'failed' : source.warmingUp ? 'warming up' : 'healthy'}
                      {source.stale && stale}
                    </span>
                  ))}
            </span>
          )}
          {readError && status && <span>Status stale — refresh failed</span>}
          <span className={styles.item}>
            <StatusDot tone={streamTone[stream]} />
            Stream: {stream}
            {stream !== 'live' && stale}
          </span>
        </div>
        <div className={styles.controls}>
          <ThemeSwitch value={preference} onChange={(value) => theme.current?.set(value)} />
          {version && <span>{version}</span>}
        </div>
      </footer>
    </div>
  );
}
