import { describe, expect, it } from 'vitest';
import { apiBaseUrl } from '../src/index.ts';

describe('apiBaseUrl', () => {
  it('adds one trailing slash to a bare origin', () => {
    expect(apiBaseUrl('http://h:1').href).toBe('http://h:1/');
  });

  it.each(['http://h/api', 'http://h/api/'])('keeps the path prefix of %s', (url) => {
    expect(apiBaseUrl(url).href).toBe('http://h/api/');
  });

  it('resolves a relative path under the prefix', () => {
    expect(new URL('sessions', apiBaseUrl('http://h/api')).href).toBe('http://h/api/sessions');
  });
});
