import { describe, expect, it } from 'vitest';
import { mcpPackageSmokeCommands } from './check.ts';

describe('MCP package smoke selection', () => {
  it('runs for an affected CLI package', () => {
    expect(mcpPackageSmokeCommands('changed', ['packages/cli'])).toEqual([
      { cmd: 'node', args: ['scripts/package-smoke-mcp.ts'] },
    ]);
  });

  it('runs for a full check', () => {
    expect(mcpPackageSmokeCommands('full', [])).toHaveLength(1);
  });

  it('does not run for unrelated packages', () => {
    expect(mcpPackageSmokeCommands('changed', ['packages/core'])).toEqual([]);
  });
});
