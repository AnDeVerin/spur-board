import { expect, it } from 'vitest';
import { safeExternalUrl, taskLinkHref } from '../src/lib/links.ts';
it.each(['https://example.org/a', 'http://example.org/'])('accepts external URL %s', (url) => {
  expect(safeExternalUrl(url)).toBe(url);
});
it.each(['javascript:alert(1)', 'data:text/html,hi', '/relative', '//example.org', 'broken'])(
  'rejects unsafe URL %s',
  (url) => {
    expect(safeExternalUrl(url)).toBeNull();
  },
);
it.each([
  ['pr', 'o/r#12', 'https://github.com/o/r/pull/12'],
  ['ticket', 'o/r#5', 'https://github.com/o/r/issues/5'],
  ['pr', 'my.org/web-app#7', 'https://github.com/my.org/web-app/pull/7'],
])('builds the GitHub URL of a %s link %s', (kind, ref, url) => {
  expect(taskLinkHref({ kind, ref })).toBe(url);
});
it.each([
  ['ticket', 'ABC-3'],
  ['session', 's1'],
  ['session', 'o/r#4'],
  ['pr', 'repo#4'],
  ['pr', 'javascript:alert(1)//o/r#1'],
  ['ticket', 'o/r#5 '],
])('builds no URL for a %s link %s', (kind, ref) => {
  expect(taskLinkHref({ kind, ref })).toBeNull();
});
