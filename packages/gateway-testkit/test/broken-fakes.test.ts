import type { Gateway, InboundEvent } from '@spur-board/contracts';
import { describe, expect, it } from 'vitest';
import { runConformanceCase, type ConformanceTarget } from '../src/conformance.ts';
import { createFakeGateway, type FakeGateway, type FakeProfile } from '../src/index.ts';

const maxTextLength = { 'slack-like': 4000, 'telegram-like': 4096 } as const;

/** A target whose gateway is a healthy fake with some members replaced. */
function broken(
  name: string,
  profile: FakeProfile,
  override: (fake: FakeGateway) => Partial<Gateway>,
): ConformanceTarget {
  return {
    name: `${name} ${profile}`,
    maxTextLength: maxTextLength[profile],
    create() {
      const fake = createFakeGateway({ profile });
      const gateway: Gateway = {
        kind: fake.kind,
        capabilities: fake.capabilities,
        start: (sink) => fake.start(sink),
        stop: () => fake.stop(),
        deliver: (request) => fake.deliver(request),
        recover: (request) => fake.recover(request),
        respond: (interaction, text, options) => fake.respond(interaction, text, options),
        ...override(fake),
      };
      return { gateway, platform: fake.platform };
    },
  };
}

/** Forgets that an earlier attempt may have landed. */
function doublePost(profile: FakeProfile): ConformanceTarget {
  return broken('doublePost', profile, (fake) => ({
    deliver: (request) => fake.deliver({ ...request, maybeSent: false }),
  }));
}

/** Gives recovered messages, edits and deletions a key other than their live one. */
function rekeyedRecover(profile: FakeProfile): ConformanceTarget {
  return broken('rekeyedRecover', profile, (fake) => ({
    async *recover(request) {
      for await (const event of fake.recover(request)) {
        const rekey: InboundEvent['kind'][] = ['message', 'message_edited', 'message_deleted'];
        yield rekey.includes(event.kind)
          ? { ...event, dedupeKey: `${event.dedupeKey}:recovered` }
          : event;
      }
    },
  }));
}

/** Posts the closing line as a plain reply and never sets the done mark. */
function closeWithoutDone(profile: FakeProfile): ConformanceTarget {
  return broken('closeWithoutDone', profile, (fake) => ({
    deliver: (request) =>
      fake.deliver(
        request.target.kind === 'close'
          ? { ...request, target: { kind: 'reply', conversation: request.target.conversation } }
          : request,
      ),
  }));
}

const profiles: FakeProfile[] = ['slack-like', 'telegram-like'];

describe('broken fakes fail the suite', () => {
  for (const profile of profiles) {
    it(`doublePost fails maybe-sent-reply with G3 (${profile})`, async () => {
      await expect(runConformanceCase(doublePost(profile), 'maybe-sent-reply')).rejects.toThrow(
        /G3/,
      );
    });

    it(`closeWithoutDone fails close-steps with G5 or G6 (${profile})`, async () => {
      await expect(runConformanceCase(closeWithoutDone(profile), 'close-steps')).rejects.toThrow(
        /G[56]/,
      );
    });
  }

  it('rekeyedRecover fails recover-keys with G8 (slack-like)', async () => {
    await expect(runConformanceCase(rekeyedRecover('slack-like'), 'recover-keys')).rejects.toThrow(
      /G8/,
    );
  });

  it('the healthy fake passes the same cases', async () => {
    for (const profile of profiles) {
      const healthy = broken('healthy', profile, () => ({}));
      await runConformanceCase(healthy, 'maybe-sent-reply');
      await runConformanceCase(healthy, 'close-steps');
      await runConformanceCase(healthy, 'recover-keys');
    }
  });
});
