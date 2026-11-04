import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSpurPort } from '../src/spur-port.ts';

describe('spur send port', () => {
  it('terminates a hung child after its deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spur-port-'));
    const command = join(dir, 'spur');
    const pidFile = join(dir, 'child.pid');
    writeFileSync(
      command,
      '#!/usr/bin/env node\n' +
        'require("node:fs").writeFileSync(process.argv[3], String(process.pid));\n' +
        'process.on("SIGTERM", () => {});\n' +
        'setInterval(() => {}, 1000);\n',
    );
    chmodSync(command, 0o700);
    const port = createSpurPort({
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      timeoutMs: 400,
      killGraceMs: 100,
    });
    await expect(port.send(pidFile, 'held')).rejects.toThrow('spur send timed out');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
