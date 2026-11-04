import { describe, expect, it } from 'vitest';
import { latestPublishedVersion, registryVersions } from './upgrade-smoke.ts';

describe('previous published version', () => {
  it('selects the newest stable published version', () => {
    expect(latestPublishedVersion('["0.1.0","0.2.0","0.2.1-beta.1","0.3.0"]')).toBe('0.3.0');
  });

  it('uses the latest published package even when the checked-in version is unchanged', () => {
    expect(latestPublishedVersion('"0.1.0"')).toBe('0.1.0');
    expect(latestPublishedVersion('["0.1.0","0.2.0"]')).toBe('0.2.0');
  });

  it('skips only when no package exists', () => {
    expect(
      registryVersions(
        1,
        '',
        'npm error code E404\nNot Found - GET https://registry.npmjs.org/spur-board',
      ),
    ).toBeNull();
  });

  it('fails on registry errors or invalid results', () => {
    expect(() => registryVersions(1, '', 'npm error code EAI_AGAIN')).toThrow('Could not read');
    expect(() => registryVersions(0, '{}', '')).toThrow('invalid version list');
  });
});
