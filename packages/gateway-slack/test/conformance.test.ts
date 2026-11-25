import { runGatewayConformance } from '@spur-board/gateway-testkit';
import { fakeCaseIds } from '@spur-board/gateway-testkit/cases';
import { vi } from 'vitest';
import { createSlackGateway } from '../src/index.ts';
import { MAX_PART_TEXT } from '../src/render.ts';
import { startFakeSlackApi } from '@spur-board/gateway-slack/testing';

// After a drop the gateway's first reconnect waits up to a second (`reconnectDelay`).
vi.setConfig({ testTimeout: 10_000 });

runGatewayConformance({
  name: 'Slack HTTP and Socket Mode fake',
  caseIds: fakeCaseIds,
  maxTextLength: MAX_PART_TEXT,
  async create() {
    const fake = await startFakeSlackApi();
    return {
      gateway: createSlackGateway({
        token: 'xoxb-test',
        now: () => Date.now(),
        appToken: 'xapp-test',
        channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
        command: '/ops',
        apiUrl: fake.url,
        requestTimeoutMs: 500,
      }),
      platform: fake.platform,
      dispose: () => fake.close(),
    };
  },
});
