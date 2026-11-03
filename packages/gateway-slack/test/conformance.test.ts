import { runGatewayConformance } from '@spur-board/gateway-testkit';
import { createSlackGateway } from '../src/index.ts';
import { MAX_PART_TEXT } from '../src/render.ts';
import { startFakeSlackApi } from './fake-api.ts';

runGatewayConformance(
  {
    name: 'Slack Web API fake',
    maxTextLength: MAX_PART_TEXT,
    async create() {
      const fake = await startFakeSlackApi();
      return {
        gateway: createSlackGateway({
          token: 'xoxb-test',
          channels: { orchestrators: 'C_ORCH', feed: 'C_FEED' },
          apiUrl: fake.url,
          requestTimeoutMs: 500,
        }),
        platform: fake.platform,
        dispose: () => fake.close(),
      };
    },
  },
  { scope: 'outbound' },
);
