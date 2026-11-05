import { describe, expect, it } from 'vitest';
import { conformanceCases, runGatewayConformance } from '../src/conformance.ts';
import {
  assertExactLiveResults,
  assertFullFakeCaseSet,
  assertSupportedLiveCaseSet,
  fakeCaseIds,
  liveCaseIds,
} from '@spur-board/gateway-testkit/cases';
import { createFakeGateway, type FakeProfile } from '../src/index.ts';

function fakeTarget(profile: FakeProfile, maxTextLength: number) {
  return {
    name: `fake ${profile}`,
    caseIds: fakeCaseIds,
    maxTextLength,
    create() {
      const fake = createFakeGateway({ profile });
      return { gateway: fake, platform: fake.platform };
    },
  };
}

runGatewayConformance(fakeTarget('slack-like', 4000));
runGatewayConformance(fakeTarget('telegram-like', 4096));

describe('conformance cases', () => {
  it('has one case per scope item, in order', () => {
    expect(conformanceCases.map((c) => c.id)).toEqual([
      'deliver-targets',
      'maybe-sent-reply',
      'maybe-sent-open',
      'parts',
      'close-steps',
      'recover-keys',
      'origin-key',
      'respond',
      'delivery-faults',
      'ack-after-sink',
      'connection-loss',
    ]);
    expect(conformanceCases.map((c) => c.id)).toEqual(fakeCaseIds);
  });

  it('rejects incomplete, duplicate and unknown fake declarations', () => {
    expect(() => {
      assertFullFakeCaseSet(fakeCaseIds);
    }).not.toThrow();
    expect(() => {
      assertFullFakeCaseSet(fakeCaseIds.slice(1));
    }).toThrow(/exactly/);
    expect(() => {
      assertFullFakeCaseSet([...fakeCaseIds, fakeCaseIds[0]]);
    }).toThrow(/exactly/);
    expect(() => {
      assertFullFakeCaseSet([...fakeCaseIds.slice(1), 'unknown']);
    }).toThrow(/exactly/);
  });

  it('accepts supported live subsets and rejects invalid selections', () => {
    expect(liveCaseIds).not.toContain('rate-limit');
    expect(() => {
      assertSupportedLiveCaseSet(['delivery', 'multipart']);
    }).not.toThrow();
    expect(() => {
      assertSupportedLiveCaseSet([]);
    }).toThrow(/non-empty/);
    expect(() => {
      assertSupportedLiveCaseSet(['delivery', 'delivery']);
    }).toThrow(/unique/);
    expect(() => {
      assertSupportedLiveCaseSet(['unknown']);
    }).toThrow(/unknown/);
    expect(() => {
      assertSupportedLiveCaseSet(['rate-limit']);
    }).toThrow(/unknown/);
  });

  it('requires one result for every declared live case, including failures', () => {
    const declared = liveCaseIds;
    const results = declared.map((id) => ({ id, status: 'fail' }));
    expect(() => {
      assertExactLiveResults(declared, results);
    }).not.toThrow();
    expect(() => {
      assertExactLiveResults(declared, results.slice(1));
    }).toThrow(/exactly/);
    expect(() => {
      assertExactLiveResults(declared, [...results, { id: 'delivery' }]);
    }).toThrow(/exactly/);
    expect(() => {
      assertExactLiveResults(declared, [...results.slice(1), { id: 'unknown' }]);
    }).toThrow(/exactly/);
  });
});
