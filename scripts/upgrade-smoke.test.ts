import { describe, expect, it } from 'vitest';
import { previousVersion, registryVersions } from './upgrade-smoke.ts';

describe('previous published version', () => {
  it('selects the newest stable version before the candidate', () => {
    expect(previousVersion('["0.1.0","0.2.0","0.2.1-beta.1","0.3.0"]', '0.3.0')).toBe('0.2.0');
    expect(previousVersion('"0.1.0"', '0.1.1')).toBe('0.1.0');
  });

  it('skips only when no earlier package exists', () => {
    expect(previousVersion('"0.1.0"', '0.1.0')).toBeNull();
    expect(
      registryVersions(
        '0.1.0',
        1,
        '',
        'npm error code E404\nNot Found - GET https://registry.npmjs.org/spur-board',
      ),
    ).toBeNull();
  });

  it('fails on registry errors or invalid results', () => {
    expect(() => registryVersions('0.2.0', 1, '', 'npm error code EAI_AGAIN')).toThrow(
      'Could not read',
    );
    expect(() => registryVersions('0.2.0', 0, '{}', '')).toThrow('invalid version list');
  });
});
