import type { ThemePreference } from '../ds/index.ts';

export type { ThemePreference };
interface Media {
  readonly matches: boolean;
  addEventListener(type: 'change', callback: () => void): void;
  removeEventListener(type: 'change', callback: () => void): void;
}
interface ThemeOptions {
  storage: () => Pick<Storage, 'getItem' | 'setItem'>;
  media: Media;
  apply: (theme: 'light' | 'dark', preference: ThemePreference) => void;
}
export function createTheme(options: ThemeOptions) {
  let preference: ThemePreference = 'dark';
  let disposed = false;
  try {
    const saved = options.storage().getItem('board-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'auto') preference = saved;
  } catch {
    /* Storage may be unavailable even when acquiring it. */
  }
  const apply = () => {
    if (!disposed)
      options.apply(
        preference === 'auto' ? (options.media.matches ? 'light' : 'dark') : preference,
        preference,
      );
  };
  const onMediaChange = () => {
    if (preference === 'auto') apply();
  };
  options.media.addEventListener('change', onMediaChange);
  apply();
  return {
    get preference() {
      return preference;
    },
    set(value: ThemePreference) {
      if (disposed) return;
      preference = value;
      try {
        options.storage().setItem('board-theme', value);
      } catch {
        /* Appearance remains usable without storage. */
      }
      apply();
    },
    dispose() {
      disposed = true;
      options.media.removeEventListener('change', onMediaChange);
    },
  };
}
