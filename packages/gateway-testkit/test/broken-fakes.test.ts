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

/** Drops deletions from a recover that reads after a known message. */
function afterDropsDeletes(profile: FakeProfile): ConformanceTarget {
  return broken('afterDropsDeletes', profile, (fake) => ({
    async *recover(request) {
      const bounded = request.conversations.some((c) => c.after !== undefined);
      for await (const event of fake.recover(request)) {
        if (!(bounded && event.kind === 'message_deleted')) yield event;
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

/** Acknowledges each event to the platform before the sink resolves. */
function ackFirst(profile: FakeProfile): ConformanceTarget {
  return broken('ackFirst', profile, (fake) => ({
    start: (sink) =>
      fake.start((event) => {
        void sink(event);
        return Promise.resolve();
      }),
  }));
}

/** Retries a call that asked to be retried once more on its own. */
function selfRetry(profile: FakeProfile): ConformanceTarget {
  return broken('selfRetry', profile, (fake) => ({
    async deliver(request) {
      const result = await fake.deliver(request);
      return result.status === 'retry' ? fake.deliver({ ...request, maybeSent: true }) : result;
    },
  }));
}

/** Never reports a lost connection. */
function silentLoss(profile: FakeProfile): ConformanceTarget {
  return broken('silentLoss', profile, (fake) => ({
    start: (sink) =>
      fake.start((event) =>
        event.kind === 'connection' && event.state === 'down' ? Promise.resolve() : sink(event),
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

    it(`ackFirst fails ack-after-sink with G11 while the sink is held (${profile})`, async () => {
      await expect(runConformanceCase(ackFirst(profile), 'ack-after-sink')).rejects.toThrow(
        /G11: the input is not acknowledged while the sink is pending/,
      );
    });

    it(`silentLoss fails connection-loss with G13 (${profile})`, async () => {
      await expect(runConformanceCase(silentLoss(profile), 'connection-loss')).rejects.toThrow(
        /G13: a lost connection emits/,
      );
    });

    it(`selfRetry fails delivery-faults with G1 (${profile})`, async () => {
      await expect(runConformanceCase(selfRetry(profile), 'delivery-faults')).rejects.toThrow(
        /G1:/,
      );
    });
  }

  it('rekeyedRecover fails recover-keys with G8 (slack-like)', async () => {
    await expect(runConformanceCase(rekeyedRecover('slack-like'), 'recover-keys')).rejects.toThrow(
      /G8/,
    );
  });

  it('afterDropsDeletes fails recover-keys with G10 (slack-like)', async () => {
    await expect(
      runConformanceCase(afterDropsDeletes('slack-like'), 'recover-keys'),
    ).rejects.toThrow(/G10:.*deletion/);
  });

  it('the healthy fake passes the same cases', async () => {
    for (const profile of profiles) {
      const healthy = broken('healthy', profile, () => ({}));
      await runConformanceCase(healthy, 'maybe-sent-reply');
      await runConformanceCase(healthy, 'close-steps');
      await runConformanceCase(healthy, 'recover-keys');
      await runConformanceCase(healthy, 'delivery-faults');
      await runConformanceCase(healthy, 'ack-after-sink');
      await runConformanceCase(healthy, 'connection-loss');
    }
  });
});
