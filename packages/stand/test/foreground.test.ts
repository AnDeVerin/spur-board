import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { foregroundStop, stopDeadline } from '../src/foreground.ts';

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

/** A started stand that stops only when the test says so. */
function fakeStand() {
  let begin: () => void = () => undefined;
  const stopping = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const stop = vi.fn(() => {
    begin();
    return new Promise<number>(() => undefined);
  });
  return { stand: { stop, stopping, exited: new Promise<number>(() => undefined) }, stop, begin };
}

function stopperFor(watchParent: boolean, parentGone: () => boolean) {
  const onTimeout = vi.fn();
  const stopper = foregroundStop({ watchParent, parentGone, timeoutMs: 10_000, onTimeout });
  let code: number | undefined;
  void stopper.expired.then((value) => {
    code = value;
  });
  return { stopper, onTimeout, code: () => code };
}

describe('foregroundStop', () => {
  it('leaves a detached child running when its parent is gone', async () => {
    const { stopper, code } = stopperFor(false, () => true);
    const { stand, stop } = fakeStand();
    stopper.checkParent();
    void stopper.attach(stand);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stop).not.toHaveBeenCalled();
    expect(code()).toBeUndefined();
  });

  it('stops a watched stand whose launcher left during startup, within the bound', async () => {
    let gone = false;
    const { stopper, code } = stopperFor(true, () => gone);
    const { stand, stop } = fakeStand();
    stopper.checkParent();
    gone = true;
    void stopper.attach(stand);
    expect(stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(code()).toBe(1);
  });

  it('delivers a stop asked for before startup returned', () => {
    const { stopper } = stopperFor(true, () => false);
    const { stand, stop } = fakeStand();
    stopper.request();
    void stopper.attach(stand);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('arms the deadline on a fatal error before the daemon handles it, with no stand yet', async () => {
    const { stopper, onTimeout, code } = stopperFor(true, () => false);
    const seen: string[] = [];
    const fatal = stopper.fatal(() => {
      seen.push('daemon');
    });
    fatal(new Error('boom'));
    expect(seen).toEqual(['daemon']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(code()).toBe(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('arms the deadline when the stand starts its own shutdown', async () => {
    const { stopper, code } = stopperFor(true, () => false);
    const { stand, begin } = fakeStand();
    void stopper.attach(stand);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(code()).toBeUndefined();
    begin();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(code()).toBe(1);
  });
});
