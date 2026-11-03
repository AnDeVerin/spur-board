import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ERRORS } from '../packages/contracts/src/errors.ts';
import { renderJsonError } from '../packages/contracts/src/error-renderers.ts';

const requestId = 'req-example-123';

export function renderErrorsDocs(): string {
  const sections = Object.entries(ERRORS).map(([code, spec]) => {
    const example = JSON.stringify(
      renderJsonError({ code: code as keyof typeof ERRORS, requestId }),
      null,
      2,
    );
    return [
      `## ${code}`,
      '',
      spec.message,
      '',
      `HTTP: ${String(spec.status ?? 'client-side')}  `,
      `Exit code: ${String(spec.exit)}  `,
      `Hint: ${spec.hint}  `,
      `Recovery: ${spec.recovery.action}  `,
      `Side effects: ${spec.recovery.sideEffects}  `,
      `Retry: maximum ${String(spec.recovery.maxRetries)}; ${spec.recovery.retryTiming}`,
      ...(spec.recovery.outcomeCheck ? [`Outcome check: ${spec.recovery.outcomeCheck}`] : []),
      '',
      'Example:',
      '',
      '```json',
      example,
      '```',
    ].join('\n');
  });
  return (
    [
      '# Errors',
      'Each error has a stable code, recovery guidance, and request ID.',
      ...sections,
    ].join('\n\n') + '\n'
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const target = fileURLToPath(new URL('../docs/errors.md', import.meta.url));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderErrorsDocs());
  console.log(`wrote ${target}`);
}
