import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OPERATIONS, buildCatalogSnapshot } from '@spur-board/contracts';
import { z } from 'zod';
import { fetchCatalogVersion } from './client.ts';
import type { ClientConfig } from './config.ts';

interface CatalogVerdict {
  clientVersion: string;
  serverVersion: string;
  matches: boolean;
}

/** Holds one verdict per daemon address and instance; `undefined` verdicts are never kept. */
interface VerdictCache {
  check(
    address: URL,
    instance: string,
    run: () => Promise<CatalogVerdict | undefined>,
  ): Promise<CatalogVerdict | undefined>;
}

const MAX_ENTRIES = 16;

let clientVersion: Promise<string> | undefined;

/** The catalog version this client was built with; the snapshot is built once per process. */
export function clientCatalogVersion(): Promise<string> {
  if (clientVersion === undefined) {
    const pending = buildCatalogSnapshot(OPERATIONS).then((snapshot) => snapshot.version);
    clientVersion = pending;
    pending.catch(() => {
      if (clientVersion === pending) clientVersion = undefined;
    });
  }
  return clientVersion;
}

/** The CLI package version, or `undefined` when its manifest cannot be read. */
export function cliPackageVersion(): string | undefined {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const version = (manifest as { version?: unknown } | null)?.version;
    return typeof version === 'string' && version ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Compares the client catalog with the daemon's; rejects when the daemon cannot answer. */
export async function compareCatalogs(
  config: ClientConfig,
): Promise<CatalogVerdict & { instance: string | undefined }> {
  const [clientVersion, served] = await Promise.all([
    clientCatalogVersion(),
    fetchCatalogVersion(config),
  ]);
  return {
    clientVersion,
    serverVersion: served.version,
    matches: clientVersion === served.version,
    instance: served.instance,
  };
}

/**
 * Compares the client catalog with the daemon instance's catalog once per cache entry. Any
 * failure returns `undefined`, so the caller carries on unchanged.
 */
export function checkCatalog(
  config: ClientConfig,
  instance: string,
  cache: VerdictCache,
): Promise<CatalogVerdict | undefined> {
  return cache.check(config.address, instance, () =>
    compareCatalogs(config).catch(() => undefined),
  );
}

/** In-process cache that shares an in-flight check between overlapping callers. */
export function memoryVerdictCache() {
  const entries = new Map<string, Promise<CatalogVerdict | undefined>>();
  const keyOf = (address: URL, instance: string) => `${address.href} ${instance}`;
  return {
    check(
      address: URL,
      instance: string,
      run: () => Promise<CatalogVerdict | undefined>,
    ): Promise<CatalogVerdict | undefined> {
      const key = keyOf(address, instance);
      const held = entries.get(key);
      if (held !== undefined) return held;
      const pending = run();
      entries.set(key, pending);
      void pending.then((verdict) => {
        if (verdict === undefined && entries.get(key) === pending) entries.delete(key);
      });
      return pending;
    },
    remember(address: URL, instance: string, verdict: CatalogVerdict): void {
      entries.set(keyOf(address, instance), Promise.resolve(verdict));
    },
  };
}

const fileEntrySchema = z.object({
  cliPackageVersion: z.string(),
  address: z.string(),
  instance: z.string(),
  clientVersion: z.string(),
  serverVersion: z.string(),
});
const fileSchema = z.object({ entries: z.array(fileEntrySchema) });
type FileEntry = z.output<typeof fileEntrySchema>;

function readEntries(path: string): FileEntry[] {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data.entries : [];
  } catch {
    return [];
  }
}

function writeEntries(path: string, entries: FileEntry[]): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify({ entries })}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing was written.
    }
  }
}

/** Verdicts kept across CLI invocations, keyed by CLI package version, address and instance. */
export function fileVerdictCache(path: string, cliVersion: string): VerdictCache {
  return {
    async check(address, instance, run) {
      const matchesKey = (entry: FileEntry) =>
        entry.cliPackageVersion === cliVersion &&
        entry.address === address.href &&
        entry.instance === instance;
      const held = readEntries(path).find(matchesKey);
      if (held !== undefined) {
        return {
          clientVersion: held.clientVersion,
          serverVersion: held.serverVersion,
          matches: held.clientVersion === held.serverVersion,
        };
      }
      const verdict = await run();
      if (verdict !== undefined) {
        const entry = {
          cliPackageVersion: cliVersion,
          address: address.href,
          instance,
          clientVersion: verdict.clientVersion,
          serverVersion: verdict.serverVersion,
        };
        const kept = readEntries(path).filter((item) => !matchesKey(item));
        writeEntries(path, [...kept, entry].slice(-MAX_ENTRIES));
      }
      return verdict;
    },
  };
}
