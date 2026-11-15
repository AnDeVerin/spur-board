import { expect, it } from 'vitest';
import { safeExternalUrl } from '../src/lib/links.ts';
it.each(['https://example.org/a', 'http://example.org/'])('accepts external URL %s', (url) => {
  expect(safeExternalUrl(url)).toBe(url);
});
it.each(['javascript:alert(1)', 'data:text/html,hi', '/relative', '//example.org', 'broken'])(
  'rejects unsafe URL %s',
  (url) => {
    expect(safeExternalUrl(url)).toBeNull();
  },
);
