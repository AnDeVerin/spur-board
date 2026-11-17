import { expect, it } from 'vitest';
import {
  safeExternalUrl,
  sessionLinkHref,
  taskLinkHref,
  ticketBrowseHref,
} from '../src/lib/links.ts';
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
it.each([
  ['https://spur.example', 'sb-1234', 'https://spur.example/sessions/sb-1234'],
  ['https://spur.example/', 'sb-1234', 'https://spur.example/sessions/sb-1234'],
  ['http://127.0.0.1:7777', 'a/b ?#', 'http://127.0.0.1:7777/sessions/a%2Fb%20%3F%23'],
])('builds the Spur session URL from origin %s and id %s', (origin, id, url) => {
  expect(sessionLinkHref(origin, id)).toBe(url);
});
it.each([null, 'javascript:alert(1)', '//spur.example', 'spur.example'])(
  'builds no Spur session URL from origin %s',
  (origin) => {
    expect(sessionLinkHref(origin, 'sb-1234')).toBeNull();
  },
);
it.each([
  ['https://j.test/browse/', 'ABC-3', 'https://j.test/browse/ABC-3'],
  ['https://j.test/jira/browse/', 'abc_x-12', 'https://j.test/jira/browse/abc_x-12'],
])('builds the Jira ticket URL from base %s and key %s', (base, key, url) => {
  expect(ticketBrowseHref(base, key)).toBe(url);
});
it.each([
  [null, 'ABC-3'],
  ['https://j.test/browse/', 'o/r#5'],
  ['https://j.test/browse/', 'repo#5'],
  ['https://j.test/browse/', 'foo bar'],
  ['https://j.test/browse/', 'ABC'],
  ['https://j.test/browse/', 'ABC-3/../x'],
  ['javascript:x/', 'ABC-3'],
])('builds no Jira ticket URL from base %s and key %s', (base, key) => {
  expect(ticketBrowseHref(base, key)).toBeNull();
});
