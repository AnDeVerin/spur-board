import { configSchema, type Config } from '@spur-board/contracts';
import { expect } from 'vitest';
import type { HostProbe } from '../src/host-metrics.ts';

/** Injected runtime fixture: each listener asks the OS for its own ephemeral port. */
export function webConfig(base: (httpPort: number) => Config): Promise<Config> {
  const config = configSchema.parse({
    ...base(1),
    web: { port: 0, publicOrigin: 'http://127.0.0.1:{port}' },
  });
  // Config files reject equal ports, including 0/0. Validate with a distinct placeholder,
  // then inject both ephemeral ports without reparsing; port 1 is never bound.
  return Promise.resolve({ ...config, http: { port: 0 } });
}

/** Runs a read-only operation through the web listener at `webAddress`; expects 200. */
export async function readOp(webAddress: string, id: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${webAddress}/v1/ops/${id}`, {
    method: 'POST',
    headers: { origin: new URL(webAddress).origin, 'content-type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { value: Record<string, unknown> }).value;
}

/**
 * A host probe with fixed raw figures (75 % memory, 73.7 % disk) that counts its calls. CPU
 * times step through `cpu`, then repeat the last entry.
 */
export function countingHostProbe(
  cpu: readonly { idle: number; total: number }[] = [{ idle: 100, total: 200 }],
): HostProbe & { calls: { cpu: number; memory: number; disk: number } } {
  const calls = { cpu: 0, memory: 0, disk: 0 };
  return {
    calls,
    cpuTimes() {
      calls.cpu += 1;
      return cpu[Math.min(calls.cpu, cpu.length) - 1] ?? { idle: 0, total: 0 };
    },
    memory() {
      calls.memory += 1;
      return { totalBytes: 8000, availableBytes: 2000 };
    },
    disk() {
      calls.disk += 1;
      return Promise.resolve({ blocks: 1000, bfree: 300, bavail: 250, bsize: 4096 });
    },
  };
}
