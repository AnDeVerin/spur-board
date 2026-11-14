import type { DeliverRequest, RichText } from '@spur-board/contracts';
import { createSlackGateway } from '../../src/index.ts';
import { startFakeSlackApi, type FakeSlackApi } from '@spur-board/gateway-slack/testing';

const fakes: FakeSlackApi[] = [];

/** Closes every fake Slack API that `setup` started; call it from `afterEach`. */
export async function closeFakes(): Promise<void> {
  for (const fake of fakes.splice(0)) await fake.close();
}

export async function setup(options: { pageSize?: number; requestTimeoutMs?: number } = {}) {
  const fake = await startFakeSlackApi({
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  fakes.push(fake);
  const gateway = createSlackGateway({
    token: 'xoxb-test',
    now: () => Date.now(),
    channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
    apiUrl: fake.url,
    requestTimeoutMs: options.requestTimeoutMs ?? 500,
  });
  return { fake, gateway };
}

export function body(text: string): RichText {
  return [{ kind: 'paragraph', children: [{ kind: 'text', text }] }];
}

export function request(key: string, text = key): DeliverRequest {
  return {
    key,
    maybeSent: false,
    target: { kind: 'open', space: 'feed', title: 'A message' },
    persona: { name: 'Test', role: 'board' },
    body: body(text),
  };
}
