import {
  type AcceptedObservation,
  type Config,
  type PrEntityRef,
  type SessionEntityRef,
  type TicketEntityRef,
} from '@spur-board/contracts';
import { startAdapters } from './index.ts';

export interface SmokeProbes {
  prs: readonly PrEntityRef[];
  tickets: readonly TicketEntityRef[];
  sessions: readonly SessionEntityRef[];
}

export interface SmokeOptions {
  fetch?: typeof fetch;
  now: () => number;
  probes?: SmokeProbes;
  writeOut: (line: string) => void;
  writeErr: (line: string) => void;
}

const emptyProbes: SmokeProbes = { prs: [], tickets: [], sessions: [] };

function safeFetch(transport: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const graphQuery =
      url.origin === 'https://api.github.com' &&
      url.pathname === '/graphql' &&
      method === 'POST' &&
      typeof init?.body === 'string' &&
      (() => {
        try {
          const body: unknown = JSON.parse(init.body);
          return (
            body !== null &&
            typeof body === 'object' &&
            'query' in body &&
            typeof body.query === 'string' &&
            /^\s*query\b/.test(body.query)
          );
        } catch {
          return false;
        }
      })();
    if (method !== 'GET' && !graphQuery) {
      throw new Error(`Smoke refused ${method} request`);
    }
    return transport(input, init);
  };
}

function normalizePercentEscapes(value: string): string {
  return value.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}

function secretForms(value: string): string[] {
  const form = new URLSearchParams({ value }).toString().slice('value='.length);
  return [...new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), form])]
    .filter((part) => part.length > 0)
    .sort((a, b) => b.length - a.length);
}

function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Decode valid bytes beside malformed UTF-8 so a neighboring secret stays detectable.
    return value.replace(/(?:%[0-9a-f]{2})+/gi, (part) => {
      const bytes = new Uint8Array(part.length / 3);
      for (let offset = 0; offset < part.length; offset += 3) {
        bytes[offset / 3] = Number.parseInt(part.slice(offset + 1, offset + 3), 16);
      }
      return new TextDecoder().decode(bytes);
    });
  }
}

function containsDecodedSecret(value: string, secrets: Readonly<Record<string, string>>): boolean {
  const values = Object.values(secrets).filter((secret) => secret.length > 0);
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      [current, current.replaceAll('+', ' ')].some((form) =>
        values.some((secret) => form.includes(secret)),
      )
    )
      return true;
    const decoded = decodePercent(current);
    if (decoded === current) break;
    current = decoded;
  }
  return false;
}

function redact(line: string, secrets: Readonly<Record<string, string>>): string {
  const forms = Object.values(secrets)
    .filter((value) => value.length > 0)
    .flatMap(secretForms)
    .sort((a, b) => b.length - a.length);
  let result = line;
  for (const form of forms) {
    const needle = normalizePercentEscapes(form);
    const normalized = normalizePercentEscapes(result);
    const parts: string[] = [];
    let cursor = 0;
    let index = normalized.indexOf(needle, cursor);
    while (index !== -1) {
      parts.push(result.slice(cursor, index), '[REDACTED]');
      cursor = index + form.length;
      index = normalized.indexOf(needle, cursor);
    }
    if (cursor > 0) result = `${parts.join('')}${result.slice(cursor)}`;
  }
  if (containsDecodedSecret(result, secrets)) return '[REDACTED]';
  return result;
}

/** Polls the configured source listings once; explicit probes add selected linked entities. */
export async function runSmoke(
  config: Config,
  secrets: Readonly<Record<string, string>>,
  options: SmokeOptions,
): Promise<number> {
  const probes = options.probes ?? emptyProbes;
  const repos = new Set(
    config.projects.flatMap((project) => project.repos.map((repo) => repo.toLowerCase())),
  );
  const trackers = new Set(
    config.projects.map((project) =>
      project.tracker.type === 'jira'
        ? `jira:${project.id}`
        : `github-issues:${project.id}:${project.tracker.repo.toLowerCase()}`,
    ),
  );
  if (probes.prs.some((ref) => !repos.has(ref.repo.toLowerCase())))
    throw new Error('PR probe repository is not configured');
  if (probes.tickets.some((ref) => !trackers.has(ref.trackerId)))
    throw new Error('Ticket probe tracker is not configured');
  const observed = new Map<string, AcceptedObservation>();
  const runner = startAdapters(
    config,
    {
      context(source) {
        return Promise.resolve({
          observe: {
            prs: source.startsWith('github:') ? probes.prs : [],
            tickets: probes.tickets.filter((ref) => ref.trackerId === source),
            sessions: source === 'spur' ? probes.sessions : [],
          },
        });
      },
      observe(source, observation) {
        observed.set(source, observation);
        return Promise.resolve();
      },
      reportSourceState() {
        return Promise.resolve();
      },
    },
    {
      secrets,
      fetch: safeFetch(options.fetch ?? fetch),
      now: options.now,
      oneShot: true,
      jiraSearchMethod: 'GET',
    },
  );
  try {
    if (runner.firstAttempts === undefined) throw new Error('Smoke runner has no first attempts');
    const attempts = await runner.firstAttempts;
    let failed = false;
    let unsafeOutput = false;
    const out: string[] = [];
    const err: string[] = [];
    for (const { source, outcome } of attempts) {
      const observation = observed.get(source);
      const reason =
        outcome?.kind === 'failed'
          ? outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error)
          : outcome === undefined
            ? 'Poll did not finish'
            : observation === undefined
              ? 'No batch was accepted'
              : !observation.batch.complete
                ? 'Incomplete batch'
                : undefined;
      const record = {
        source,
        status: reason === undefined ? 'pass' : 'fail',
        ...(reason === undefined ? {} : { reason }),
        items: observation?.batch.items ?? [],
        complete: observation?.batch.complete ?? false,
        effectiveComplete: observation?.effectiveComplete ?? false,
        entities: observation?.batch.entities ?? [],
        outcomes: observation?.outcomes ?? [],
        ...(observation?.batch.budget === undefined ? {} : { budget: observation.batch.budget }),
      };
      if (redact(source, secrets) !== source || redact(record.status, secrets) !== record.status)
        unsafeOutput = true;
      const line = JSON.stringify(record, (_key: string, value: unknown) =>
        typeof value === 'string' ? redact(value, secrets) : value,
      );
      out.push(`${line}\n`);
      if (reason !== undefined) {
        failed = true;
        err.push(`${redact(`${source}: ${reason}`, secrets)}\n`);
      }
    }
    const output = `${out.join('')}${err.join('')}`;
    if (
      unsafeOutput ||
      Object.values(secrets)
        .filter((value) => value.length > 0)
        .flatMap(secretForms)
        .some((form) => normalizePercentEscapes(output).includes(normalizePercentEscapes(form))) ||
      containsDecodedSecret(output, secrets)
    ) {
      const warning = 'Smoke output withheld: it would contain a configured secret value\n';
      if (!containsDecodedSecret(warning, secrets)) options.writeErr(warning);
      return 1;
    }
    for (const line of out) options.writeOut(line);
    for (const line of err) options.writeErr(line);
    return failed ? 1 : 0;
  } finally {
    await runner.stop();
  }
}
