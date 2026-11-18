import { useEffect, useRef, useState } from 'react';
import { Board } from './board/Board.tsx';
import { createBoardData } from './board/data.ts';
import { createTheme, type ThemePreference } from './lib/theme.ts';
import { StatusBar } from './board/StatusBar.tsx';
import styles from './App.module.css';

export function App() {
  const [data] = useState(() => {
    // The daemon that served this page names its version; a daemon on another one reloads it.
    const version = document.querySelector<HTMLMetaElement>('meta[name="board-version"]')?.content;
    return createBoardData({
      fetch: (input, init) => fetch(input, init),
      storage: () => localStorage,
      now: () => Date.now(),
      ...(version === undefined || version === ''
        ? {}
        : {
            update: {
              version,
              session: () => sessionStorage,
              reload: () => {
                location.reload();
              },
            },
          }),
    });
  });
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
  return (
    <div className={styles.shell}>
      {/* A stable wrapper: it turns inert as one while the services panel is open, banners too. */}
      <div className={styles.board}>
        <Board data={data} />
      </div>
      <StatusBar
        data={data}
        preference={preference}
        onTheme={(value) => {
          theme.current?.set(value);
        }}
      />
    </div>
  );
}
