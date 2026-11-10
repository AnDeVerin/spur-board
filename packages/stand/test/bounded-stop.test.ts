import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedStop } from '../src/stand.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeStand(exited: Promise<number>) {
  const stop = vi.fn(() => exited);
  return { stand: { stop, exited }, stop };
}

describe('boundedStop', () => {
  it('gives up with exit 1 when the stand does not stop within the bound', async () => {
    const { stand, stop } = fakeStand(new Promise<number>(() => undefined));
    const onTimeout = vi.fn();
    const stopping = boundedStop(stand, 10_000, onTimeout);
    let code: number | undefined;
    void stopping.exited.then((value) => {
      code = value;
    });
    stopping.request();
    stopping.request();
    expect(stop).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(code).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(code).toBe(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('resolves the stand exit code when it stops in time and arms no timer before a request', async () => {
    let finish: (code: number) => void = () => undefined;
    const { stand } = fakeStand(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );
    const onTimeout = vi.fn();
    const stopping = boundedStop(stand, 10_000, onTimeout);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onTimeout).not.toHaveBeenCalled();
    stopping.request();
    finish(0);
    expect(await stopping.exited).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('resolves an exit that happens on its own without a request', async () => {
    const { stand } = fakeStand(Promise.resolve(3));
    expect(await boundedStop(stand, 10_000, vi.fn()).exited).toBe(3);
  });
});
