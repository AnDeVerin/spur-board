import { describe, expect, it } from 'vitest';
import { statusOutputSchema } from '@spur-board/contracts/browser';
import { footerVersion } from '../src/lib/version.ts';

const status = (version: string) =>
  statusOutputSchema.parse({
    items: [],
    warmingUp: false,
    spurUnavailable: null,
    hostLoad: null,
    host: null,
    services: [],
    transport: [],
    sources: [],
    tasks: [],
    projectBlocks: [],
    unlinkedPrs: [],
    unlinkedSessions: [],
    hiddenUnlinkedPrs: 0,
    hiddenUnlinkedSessions: 0,
    bindings: { columns: [], operators: [], defaultAddressee: null },
    daemon: { version, startedAt: '2026-01-05T08:00:00.000Z', lastDispatchAt: null },
  });

describe('footer version', () => {
  it('shows the version the daemon reports in status.get', () => {
    expect(footerVersion(status('9.8.7-rc.1'))).toBe('v9.8.7-rc.1');
  });
  it('shows nothing before the first status read', () => {
    expect(footerVersion(undefined)).toBeNull();
  });
});
