import { pino, type DestinationStream, type Logger } from 'pino';

// Keys whose values are credentials wherever they appear in a log object.
const REDACT_PATHS = [
  'authorization',
  '*.authorization',
  'headers.authorization',
  '*.headers.authorization',
  'token',
  '*.token',
];

const REDACTED = '[Redacted]';
// Shorter values are too likely to match ordinary text.
const MIN_SECRET_LENGTH = 8;

/**
 * Wraps a destination so each finished line has every known secret value replaced, raw and in
 * its JSON-escaped form. It sees the serialized line, so err.stack and child bindings are covered.
 */
function scrubbing(
  dest: DestinationStream,
  secrets: Readonly<Record<string, string>>,
): DestinationStream {
  const needles = new Set<string>();
  for (const value of Object.values(secrets)) {
    if (value.length < MIN_SECRET_LENGTH) continue;
    needles.add(value);
    needles.add(JSON.stringify(value).slice(1, -1));
  }
  if (needles.size === 0) return dest;
  // Longest first, so a secret that contains another is replaced whole.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return {
    write(line: string) {
      let out = line;
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
  return pino({ redact: { paths: REDACT_PATHS, censor: REDACTED } }, scrubbing(dest, secrets));
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
