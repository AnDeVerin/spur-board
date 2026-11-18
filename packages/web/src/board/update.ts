/**
 * The page's version check: a daemon answer whose `x-board-version` differs from the version the
 * page was served with reloads the page once, keeping unsent text in session storage.
 */

/**
 * A daemon on another version answered. `reloading`: the page reloads now. `deferred`: a send is
 * in flight and the reload waits for it, up to `DEFER_LIMIT_MS`. `blocked`: the page will not
 * reload itself, because it already reloaded once for this version, a send outlasted the wait, or
 * session storage failed; `keepsDrafts` is false only for the last.
 */
export interface BoardUpdate {
  version: string;
  mode: 'reloading' | 'deferred' | 'blocked';
  keepsDrafts: boolean;
}

export interface UpdateOptions {
  /** The version in the page's `board-version` meta. */
  version: string;
  session: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  reload: () => void;
}

/**
 * The unsent text of the mounted writers. A writer reads `restored` once, then reports its text
 * after every commit and releases it on unmount. `busy` is a send or its reread in flight.
 */
interface Drafts {
  restored(id: string): string | undefined;
  report(id: string, entry: { text: string; busy: boolean }): void;
  release(id: string): void;
}

interface UpdateCheck {
  /** Wraps the board's fetch: every answer, the event stream's included, is checked. */
  fetch: (fetcher: typeof fetch) => typeof fetch;
  drafts: Drafts;
  /** The user's Reload: keeps what text it can, sends in flight included, and never publishes. */
  reload: () => void;
  stop: () => void;
}

const DRAFTS_KEY = 'board-drafts';
/**
 * How long a deferred reload waits for sends in flight. A send or its reread has no timeout of its
 * own; past this the update turns `blocked`, so the banner offers Reload, and nothing is cut off
 * until the user presses it.
 */
const DEFER_LIMIT_MS = 15_000;
const TARGET_KEY = 'board-reload-target';

function parseDrafts(raw: string): [string, string][] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === 'string';
  });
}

/**
 * Without `options` nothing here touches session storage. `publish` hears each change of the
 * update: at most twice per page, on detection and when a deferred reload fires, is blocked or
 * outlasts `DEFER_LIMIT_MS`.
 */
export function createUpdateCheck(
  options: UpdateOptions | undefined,
  publish: (update: BoardUpdate) => void,
): UpdateCheck {
  if (options === undefined)
    return {
      fetch: (fetcher) => fetcher,
      drafts: {
        restored: () => undefined,
        report: () => undefined,
        release: () => undefined,
      },
      reload: () => undefined,
      stop: () => undefined,
    };
  const { version } = options;
  let stopped = false;
  let fired = false;
  // One throw from session storage is remembered; no session call follows it.
  let storageFailed = false;
  let matched = false;
  let current: BoardUpdate | undefined;
  let deferTimer: ReturnType<typeof setTimeout> | undefined;
  const restored = new Map<string, string>();
  const reported = new Map<string, { text: string; busy: boolean }>();

  const session = <T>(use: (storage: ReturnType<UpdateOptions['session']>) => T) => {
    if (storageFailed) return undefined;
    try {
      return use(options.session());
    } catch {
      storageFailed = true;
      return undefined;
    }
  };
  const set = (next: BoardUpdate) => {
    clearTimeout(deferTimer);
    deferTimer = undefined;
    current = next;
    publish(next);
  };
  const busy = () => [...reported.values()].some((entry) => entry.busy);
  /** Writes the unsent text and the reload target; false when session storage failed. */
  const save = (target: string) =>
    session((storage) => {
      const drafts: Record<string, string> = Object.fromEntries(restored);
      for (const [id, entry] of reported) if (entry.text !== '') drafts[id] = entry.text;
      if (Object.keys(drafts).length > 0) storage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
      storage.setItem(TARGET_KEY, target);
      return true;
    }) === true;
  const fire = (target: string) => {
    if (!save(target)) {
      set({ version: target, mode: 'blocked', keepsDrafts: false });
      return;
    }
    fired = true;
    set({ version: target, mode: 'reloading', keepsDrafts: true });
    options.reload();
  };
  const detect = (target: string) => {
    const marker = session((storage) => storage.getItem(TARGET_KEY));
    if (storageFailed) set({ version: target, mode: 'blocked', keepsDrafts: false });
    else if (marker === target) set({ version: target, mode: 'blocked', keepsDrafts: true });
    else if (busy()) {
      set({ version: target, mode: 'deferred', keepsDrafts: true });
      deferTimer = setTimeout(() => {
        // The user's Reload already went: the page is leaving.
        if (!fired) set({ version: target, mode: 'blocked', keepsDrafts: true });
      }, DEFER_LIMIT_MS);
    } else fire(target);
  };
  const observe = (response: Response) => {
    if (stopped) return;
    const header = response.headers.get('x-board-version');
    if (header === null || header === '') return;
    if (header === version) {
      if (matched) return;
      matched = true;
      session((storage) => {
        if (storage.getItem(TARGET_KEY) !== null) storage.removeItem(TARGET_KEY);
      });
    } else if (current === undefined) detect(header);
  };
  const settle = () => {
    if (current?.mode === 'deferred' && !busy()) fire(current.version);
  };

  // Read once at construction: writers read their text during their first render, before start.
  session((storage) => {
    const raw = storage.getItem(DRAFTS_KEY);
    if (raw === null) return;
    storage.removeItem(DRAFTS_KEY);
    for (const [id, text] of parseDrafts(raw)) restored.set(id, text);
  });

  return {
    fetch: (fetcher) => async (input, init) => {
      const response = await fetcher(input, init);
      observe(response);
      return response;
    },
    drafts: {
      restored: (id) => restored.get(id),
      report(id, entry) {
        if (stopped || fired) return;
        reported.set(id, entry);
        restored.delete(id);
        settle();
      },
      release(id) {
        if (stopped || fired) return;
        reported.delete(id);
        settle();
      },
    },
    reload() {
      if (stopped || fired) return;
      fired = true;
      if (current !== undefined) save(current.version);
      options.reload();
    },
    stop() {
      stopped = true;
      clearTimeout(deferTimer);
      deferTimer = undefined;
    },
  };
}
