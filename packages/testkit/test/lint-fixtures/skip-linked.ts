import { describe, it } from 'vitest';

it.skip('is quarantined', () => {}); // flaky: #123

// flaky: https://github.com/owner/repo/issues/7
describe.skip('is quarantined too', () => {});
