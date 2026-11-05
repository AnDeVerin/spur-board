import { runGatewayConformance } from '@spur-board/gateway-testkit';
import { vi } from 'vitest';
import { createSlackGateway } from '../src/index.ts';
import { MAX_PART_TEXT } from '../src/render.ts';
import { startFakeSlackApi } from './fake-api.ts';

// The SDK's first automatic reconnect waits 5 seconds before opening a new socket.
vi.setConfig({ testTimeout: 10_000 });

runGatewayConformance({
  name: 'Slack HTTP and Socket Mode fake',
  maxTextLength: MAX_PART_TEXT,
  async create() {
    const fake = await startFakeSlackApi();
    return {
      gateway: createSlackGateway({
        token: 'xoxb-test',
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
