import { describe, expect, it } from 'vitest';
import { lastLocalSlot } from '../../src/domain/slot.ts';

const at = (iso: string): number => Date.parse(iso);
const slot = (...args: Parameters<typeof lastLocalSlot>): string =>
  new Date(lastLocalSlot(...args)).toISOString();

describe('lastLocalSlot', () => {
  it('returns UTC midnight of the latest weekday in UTC', () => {
    // 2026-11-05 is a Thursday.
    expect(slot(at('2026-11-05T10:00:00.000Z'), 'UTC', 'monday')).toBe('2026-11-02T00:00:00.000Z');
  });

  it('returns today when the target weekday is today', () => {
    // 2026-11-03 is a Tuesday.
    expect(slot(at('2026-11-03T10:00:00.000Z'), 'UTC', 'tuesday')).toBe('2026-11-03T00:00:00.000Z');
  });

  it('uses the local offset of the slot day across a DST switch', () => {
    // America/New_York moves to EDT on 2026-03-08 and back to EST on 2026-11-01.
    expect(slot(at('2026-03-10T12:00:00.000Z'), 'America/New_York', 'friday')).toBe(
      '2026-03-06T05:00:00.000Z',
    );
    expect(slot(at('2026-11-03T12:00:00.000Z'), 'America/New_York', 'saturday')).toBe(
      '2026-10-31T04:00:00.000Z',
    );
    // The switch day itself starts at local midnight before the 2 a.m. change.
    expect(slot(at('2026-03-08T12:00:00.000Z'), 'America/New_York', 'sunday')).toBe(
      '2026-03-08T05:00:00.000Z',
    );
  });

  it('counts now exactly at local midnight as the new day', () => {
    const midnight = at('2026-11-03T05:00:00.000Z');
    expect(slot(midnight, 'America/New_York', 'tuesday')).toBe('2026-11-03T05:00:00.000Z');
    expect(slot(midnight - 1, 'America/New_York', 'tuesday')).toBe('2026-10-27T04:00:00.000Z');
  });
});
