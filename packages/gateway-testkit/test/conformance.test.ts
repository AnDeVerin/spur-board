import { describe, expect, it } from 'vitest';
import { conformanceCases, outboundCaseIds, runGatewayConformance } from '../src/conformance.ts';
import { createFakeGateway, type FakeProfile } from '../src/index.ts';

function fakeTarget(profile: FakeProfile, maxTextLength: number) {
  return {
    name: `fake ${profile}`,
    maxTextLength,
    create() {
      const fake = createFakeGateway({ profile });
      return { gateway: fake, platform: fake.platform };
    },
  };
}

runGatewayConformance(fakeTarget('slack-like', 4000));
runGatewayConformance(fakeTarget('telegram-like', 4096));
runGatewayConformance(
  { ...fakeTarget('slack-like', 4000), name: 'fake slack-like outbound' },
  { scope: 'outbound' },
);

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
  });

  it('selects exactly the six outbound cases', () => {
    expect(outboundCaseIds).toEqual([
      'deliver-targets',
      'maybe-sent-reply',
      'maybe-sent-open',
      'parts',
      'close-steps',
      'delivery-faults',
    ]);
  });
});
