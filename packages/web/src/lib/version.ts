import type { z } from 'zod';
import type { statusOutputSchema } from '@spur-board/contracts/browser';

/** Status bar version from the running daemon, `board <version>`; null before the first status read. */
export function footerVersion(status: z.output<typeof statusOutputSchema> | undefined) {
  return status ? `board ${status.daemon.version}` : null;
}
