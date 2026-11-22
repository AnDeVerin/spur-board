/**
 * Levels of host usage shared by the web meters, the status bar dot and the board's disk item:
 * a reading is at a level when its used fraction is at or above it, as the Meter colours it.
 */
export const HOST_USAGE_LEVELS = { warn: 0.8, error: 0.9 } as const;

export type HostUsageLevel = 'ok' | 'warn' | 'error';

/** The level of a reading given in percent used, 0-100. */
export function hostUsageLevel(usedPercent: number): HostUsageLevel {
  const used = usedPercent / 100;
  if (used >= HOST_USAGE_LEVELS.error) return 'error';
  if (used >= HOST_USAGE_LEVELS.warn) return 'warn';
  return 'ok';
}
