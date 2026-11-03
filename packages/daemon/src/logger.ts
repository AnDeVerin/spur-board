import { pino, type DestinationStream, type Logger } from 'pino';

const REDACTED = '[Redacted]';
// Shorter values are too likely to match ordinary text.
const MIN_SECRET_LENGTH = 8;
// Keys whose values are credentials, matched at any depth and in any casing:
// (proxy-)authorization, (set-)cookie, and token or any key ending in it (accessToken, bot_token).
const CREDENTIAL_KEY = /^(?:proxy-)?authorization$|^(?:set-)?cookie$|token$/i;

/** A copy of `value` with every credential key's value replaced, at any depth. */
function censorKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(censorKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = CREDENTIAL_KEY.test(key) ? REDACTED : censorKeys(inner);
  }
  return out;
}

const WITHHELD = 'log line withheld: redaction failed';

/**
 * Wraps a destination so each finished line has credential keys censored at any depth and every
 * known secret value replaced, raw and in its JSON-escaped form. It works on the serialized line,
 * so err fields, err.stack and child bindings are covered too.
 */
function redacting(
  dest: DestinationStream,
  secrets: Readonly<Record<string, string>>,
): DestinationStream {
  const needles = new Set<string>();
  for (const value of Object.values(secrets)) {
    if (value.length < MIN_SECRET_LENGTH) continue;
    needles.add(value);
    needles.add(JSON.stringify(value).slice(1, -1));
  }
  // Longest first, so a secret that contains another is replaced whole.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return {
    write(line: string) {
      let out: string;
      try {
        out = `${JSON.stringify(censorKeys(JSON.parse(line)))}\n`;
      } catch (err) {
        // Fail closed: a line that cannot be censored (not JSON, or nested deep enough to overflow
        // the stack) is replaced, never written as is. Only the error's name is kept, because a
        // parse error message can quote the line.
        const reason = err instanceof Error ? err.name : 'unknown';
        out = `${JSON.stringify({ level: 50, msg: WITHHELD, reason })}\n`;
      }
      for (const needle of ordered) out = out.replaceAll(needle, REDACTED);
      dest.write(out);
    },
  };
}

/** A JSON logger that writes to `dest` with credential keys and secret values redacted. */
export function createLogger(
  dest: DestinationStream,
  secrets: Readonly<Record<string, string>>,
): Logger {
  return pino({}, redacting(dest, secrets));
}

/** The only source of wall time in daemon code; main.ts binds the real one. */
export interface Clock {
  now(): number;
}

/** Runs one external call and logs its duration and outcome. Rethrows the same error. */
export async function logCall<T>(
  log: Logger,
  clock: Clock,
  call: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = clock.now();
  try {
    const value = await fn();
    log.info({ call, duration_ms: clock.now() - start, outcome: 'ok' }, 'external call');
    return value;
  } catch (err) {
    log.warn({ call, duration_ms: clock.now() - start, outcome: 'error', err }, 'external call');
    throw err;
  }
}
