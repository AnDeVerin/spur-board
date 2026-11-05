/** Case identities shared by the fake suite and the manual live runner. */
export const fakeCaseIds = [
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
] as const;

export type FakeCaseId = (typeof fakeCaseIds)[number];

export const liveCases = [
  { id: 'delivery', title: 'open, reply, edit and close' },
  { id: 'multipart', title: 'multi-part delivery' },
  { id: 'maybe-sent', title: 'recent post search and duplicate protection' },
  { id: 'recovery', title: 'thread history recovery after disconnect' },
  { id: 'rate-limit', title: 'Retry-After recovery' },
  { id: 'bot-posts', title: 'bot posts are ignored' },
  { id: 'guided-reply', title: 'human thread reply' },
  { id: 'guided-edit', title: 'human edit' },
  { id: 'guided-button', title: 'button press' },
  { id: 'guided-slash', title: 'slash command' },
  { id: 'guided-mention', title: 'thread mention' },
] as const;

export type LiveCaseId = (typeof liveCases)[number]['id'];
export const liveCaseIds: readonly LiveCaseId[] = liveCases.map((entry) => entry.id);

/** A fake must declare the whole suite, even when it only wants to test one behavior. */
export function assertFullFakeCaseSet(ids: readonly string[]): void {
  assertExactCaseSet(fakeCaseIds, ids, 'fake');
}

/** A live target can select supported cases, but cannot invent or repeat case IDs. */
export function assertSupportedLiveCaseSet(ids: readonly string[]): void {
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error('live conformance cases must be non-empty and unique');
  }
  if (ids.some((id) => !liveCaseIds.includes(id as LiveCaseId))) {
    throw new Error('live conformance cases contain an unknown ID');
  }
}

/** A report must contain one result for every declared live case, including failures. */
export function assertExactLiveResults(
  declaredIds: readonly string[],
  results: readonly { id: string }[],
): void {
  assertSupportedLiveCaseSet(declaredIds);
  assertExactCaseSet(
    declaredIds,
    results.map((result) => result.id),
    'live result',
  );
}

function assertExactCaseSet(expected: readonly string[], actual: readonly string[], label: string) {
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((id) => !actual.includes(id))
  ) {
    throw new Error(`${label} conformance cases must match their declaration exactly`);
  }
}
