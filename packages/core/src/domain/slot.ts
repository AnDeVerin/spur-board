import type { Config } from '@spur-board/contracts';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The UTC instant of local midnight on the latest `weekday` at or before `now` in `tz`.
 * A day that starts at `now` counts as today.
 */
export function lastLocalSlot(
  now: number,
  tz: string,
  weekday: Config['archive']['doneWeekday'],
): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = (time: number): string => {
    const parts = formatter.formatToParts(time);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (year === undefined || month === undefined || day === undefined)
      throw new Error('Archive timezone did not yield a local date');
    return `${year}-${month}-${day}`;
  };
  const [year = 0, month = 0, day = 0] = localDate(now).split('-').map(Number);
  const localMidnight = Date.UTC(year, month - 1, day);
  const today = new Date(localMidnight).getUTCDay();
  const target = WEEKDAYS.indexOf(weekday);
  const targetUtcDate = localMidnight - ((today - target + 7) % 7) * 86_400_000;
  const targetDate = new Date(targetUtcDate).toISOString().slice(0, 10);
  let lower = targetUtcDate - 2 * 86_400_000;
  let upper = targetUtcDate + 2 * 86_400_000;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (localDate(middle) < targetDate) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}
