import { expectTypeOf, it } from 'vitest';
import type { Gateway, InboundEvent } from '../../src/index.ts';

const noEvents: AsyncIterable<InboundEvent> = {
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true as const, value: undefined }),
  }),
};

const minimal = {
  kind: 'test',
  capabilities: { history: false, markerSearch: false, privateResponses: false },
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  deliver: () => Promise.resolve({ status: 'retry' as const, uncertain: false }),
  recover: () => noEvents,
  respond: () => Promise.resolve('dropped' as const),
};
type Minimal = typeof minimal;

it('accepts a minimal gateway', () => {
  expectTypeOf(minimal).toExtend<Gateway>();
});

it('rejects a gateway missing any member', () => {
  expectTypeOf<Omit<Minimal, 'kind'>>().not.toExtend<Gateway>();
  expectTypeOf<Omit<Minimal, 'capabilities'>>().not.toExtend<Gateway>();
  expectTypeOf<Omit<Minimal, 'start'>>().not.toExtend<Gateway>();
  expectTypeOf<Omit<Minimal, 'stop'>>().not.toExtend<Gateway>();
  expectTypeOf<Omit<Minimal, 'deliver'>>().not.toExtend<Gateway>();
  expectTypeOf<Omit<Minimal, 'recover'>>().not.toExtend<Gateway>();
  expectTypeOf<Omit<Minimal, 'respond'>>().not.toExtend<Gateway>();
});
