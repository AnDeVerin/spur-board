import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopDeadline } from '../src/stand.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('stopDeadline', () => {
  it('expires with 1 once the bound passes after the first arm', async () => {
    const onTimeout = vi.fn();
    const deadline = stopDeadline(10_000, onTimeout);
    let code: number | undefined;
    void deadline.expired.then((value) => {
      code = value;
    });
    deadline.arm();
    await vi.advanceTimersByTimeAsync(5_000);
    // A second arm, e.g. the stand reporting the stop a signal started, keeps the first timer.
    deadline.arm();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(code).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(code).toBe(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('never expires until armed', async () => {
    const onTimeout = vi.fn();
    const deadline = stopDeadline(10_000, onTimeout);
    let code: number | undefined;
    void deadline.expired.then((value) => {
      code = value;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(code).toBeUndefined();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
