import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  focusRing,
  HoverMenu,
  Icon,
  quiet,
  StatusDot,
  type HoverMenuItem,
  type ThemePreference,
} from '../ds/index.ts';
import { footerVersion } from '../lib/version.ts';
import type { BoardData } from './data.ts';
import { formatDataTime, openHref } from './model.ts';
import { indicators, type ServiceName } from './services.ts';
import { ServicesPanel, type ScrollRequest } from './ServicesPanel.tsx';
import styles from './StatusBar.module.css';

const OPEN = 'services';
const THEMES: readonly HoverMenuItem<ThemePreference>[] = [
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
  { value: 'auto', label: 'Auto', icon: 'auto' },
];
const THEME_ICONS = { light: 'sun', dark: 'moon', auto: 'auto' } as const;

const isOpen = () => new URLSearchParams(location.search).get('open') === OPEN;
const join = (...names: (string | undefined)[]) => names.filter(Boolean).join(' ');

/**
 * The status bar: the services trigger and one button per service on the left, the theme menu
 * and the daemon version on the right. The services panel is open while the address has
 * `?open=services`; it renders after the footer, so the footer is attached when the panel mounts
 * and stays live while it is open.
 */
export function StatusBar({
  data,
  preference,
  onTheme,
}: {
  data: BoardData;
  preference: ThemePreference;
  onTheme: (value: ThemePreference) => void;
}) {
  const snapshot = useSyncExternalStore(data.subscribe, data.snapshot);
  const [open, setOpen] = useState(isOpen);
  const [scroll, setScroll] = useState<ScrollRequest>();
  const footer = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const sync = () => {
      setOpen(isOpen());
    };
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('popstate', sync);
    };
  }, []);
  useEffect(() => {
    // A panel opened by a deep link has no opener to return focus to.
    const active = document.activeElement;
    if (wasOpen.current && !open && (active === null || active === document.body))
      trigger.current?.focus();
    wasOpen.current = open;
  }, [open]);
  const show = (service?: ServiceName) => {
    if (!open) {
      history.pushState(null, '', openHref(OPEN));
      setOpen(true);
    }
    if (service) setScroll((last) => ({ service, seq: (last?.seq ?? 0) + 1 }));
  };
  const hide = () => {
    const url = new URL(location.href);
    url.searchParams.delete('open');
    history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    setOpen(false);
  };
  const version = footerVersion(snapshot.status);
  return (
    <>
      <footer ref={footer} className={join(quiet, styles.bar)} aria-label="Board status">
        <button
          ref={trigger}
          className={join(focusRing, styles.trigger)}
          type="button"
          aria-label="services"
          aria-expanded={open}
          onClick={() => {
            if (open) hide();
            else show();
          }}
        >
          <Icon name="pulse" />
          <span className={styles.label}>services</span>
        </button>
        {indicators(snapshot, formatDataTime).map((item) => (
          <button
            key={item.service}
            className={join(focusRing, styles.service)}
            type="button"
            aria-label={item.label}
            title={item.title}
            onClick={() => {
              show(item.service);
            }}
          >
            <Icon name={item.icon} />
            <StatusDot tone={item.tone} hollow={item.tone === 'unknown'} />
          </button>
        ))}
        <span className={styles.spacer} />
        <HoverMenu
          label="Theme"
          icon={THEME_ICONS[preference]}
          items={THEMES}
          value={preference}
          onSelect={onTheme}
        />
        {version && <span>{version}</span>}
      </footer>
      <ServicesPanel
        snapshot={snapshot}
        open={open}
        onClose={hide}
        scroll={scroll}
        keepLive={footer}
      />
    </>
  );
}
