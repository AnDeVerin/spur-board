import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Board } from './board/Board.tsx';
import { createBoardData } from './board/data.ts';
import { createTheme, type ThemePreference } from './lib/theme.ts';
import { Chip, StatusDot, ThemeSwitch } from './ds/index.ts';
import { footerVersion } from './lib/version.ts';
import styles from './App.module.css';

const stale = (
  <>
    {' '}
    <Chip tone="warn">stale</Chip>
  </>
);
export function App() {
  const [data] = useState(() =>
    createBoardData({
      fetch: (input, init) => fetch(input, init),
      storage: () => localStorage,
      now: () => Date.now(),
    }),
  );
  const { status, readFailed } = useSyncExternalStore(data.subscribe, data.snapshot);
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
    data.start();
    return () => {
      data.stop();
      theme.current?.dispose();
    };
  }, [data]);
  const version = footerVersion(status);
  return (
    <div className={styles.shell}>
      <Board data={data} />
      <footer className={styles.footer} aria-label="Board status">
        <div className={styles.status} aria-live="polite">
          <span>
            {status
              ? `${String(status.tasks.length)} tasks`
              : readFailed
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
        </div>
        <div className={styles.controls}>
          <ThemeSwitch value={preference} onChange={(value) => theme.current?.set(value)} />
          {version && <span>{version}</span>}
        </div>
      </footer>
    </div>
  );
}
