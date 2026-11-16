import type { z } from 'zod';
import type { statusOutputSchema } from '@spur-board/contracts/browser';

/** Footer version from the running daemon; null before the first status read. */
export function footerVersion(status: z.output<typeof statusOutputSchema> | undefined) {
  return status ? `v${status.daemon.version}` : null;
}
