// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { daemon, deferred, envelope, hello, problem, taskGet } from './board-fixtures.ts';
import { mount, mountEachTest, settle } from './board-harness.ts';

mountEachTest();
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe('latest submission in Task Now', () => {
  it('inherits task loading, failure, retry and retained data with no extra read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = daemon();
    let reads = 0;
    const held = deferred();
    d.routes['task.get'] = () => {
      reads++;
      return held.promise;
    };
    history.replaceState(null, '', '/?open=ex%2Frepo%237');
    mount(d);
    await settle();
    d.send(hello);
    await settle();
    expect(dialog()?.textContent).not.toContain('Latest submission');
    held.resolve(await problem('unexpected', 500));
    await settle();
    expect(dialog()?.textContent).toContain('Could not load the task.');
    const value = {
      ...taskGet(),
      submission: {
        column: 'dev' as const,
        at: '2026-11-15T13:00:00.000Z',
        sha: 'a'.repeat(40),
        basis: 'skipped' as const,
        from: null,
        testedOrigin: null,
        reason: 'Retain this reason',
        pending: false,
        voided: false,
      },
    };
    d.routes['task.get'] = () => {
      reads++;
      return Promise.resolve(envelope(value));
    };
    const retry = [...(dialog()?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Retry',
    );
    if (!retry) throw new Error('No retry');
    const beforeRetry = reads;
    act(() => {
      retry.click();
    });
    await settle();
    expect(dialog()?.textContent).toContain('Retain this reason');
    expect(reads).toBe(beforeRetry + 1);
    d.routes['task.get'] = () => {
      reads++;
      return problem('unexpected', 500);
    };
    const beforeReread = reads;
    d.send('event: invalidate\ndata: {"projects":[],"tasks":["ex/repo#7"]}\n\n');
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(400));
    await settle();
    expect(dialog()?.textContent).toContain('Could not load the task.');
    expect(dialog()?.textContent).toContain('Retain this reason');
    expect(reads).toBe(beforeReread + 1);
  });

  it.each(['tested', 'carried', 'skipped', 'null', 'absent'] as const)(
    'shows latest submission %s after Why and before discussion as literal text',
    async (basis) => {
      const d = daemon();
      const reason = '<img src=x onerror=alert(1)> <!here> *bold*' + 'x'.repeat(1900);
      const submission =
        basis === 'null'
          ? null
          : {
              column: 'review' as const,
              at: '2026-11-15T13:00:00.000Z',
              sha: 'b'.repeat(40),
              basis: basis === 'absent' ? ('tested' as const) : basis,
              from: basis === 'carried' ? 'c'.repeat(40) : null,
              testedOrigin: basis === 'carried' ? 'a'.repeat(40) : null,
              reason,
              pending: true,
              voided: true,
            };
      d.routes['task.get'] = () =>
        Promise.resolve(envelope({ ...taskGet(), ...(basis === 'absent' ? {} : { submission }) }));
      history.replaceState(null, '', '/?open=ex%2Frepo%237');
      mount(d);
      await settle();
      const text = dialog()?.textContent ?? '';
      if (basis === 'absent') expect(text).not.toContain('Latest submission');
      else {
        expect(text.indexOf('Latest submission')).toBeGreaterThan(text.indexOf('Why it is here'));
        expect(text.indexOf('Latest submission')).toBeLessThan(text.indexOf('Blocks'));
        if (basis === 'null') expect(text).toContain('No submissions yet');
        else {
          expect(text).toContain(reason);
          expect(text).toContain('b'.repeat(40));
          expect(text).toContain(`Basis${basis}`);
          expect(text).toContain('PendingYesVoidedYes');
          expect(dialog()?.querySelector('img')).toBeNull();
          if (basis === 'carried') expect(text).toContain('Tested origin SHA' + 'a'.repeat(40));
        }
      }
      expect(dialog()?.querySelectorAll('[role="alert"]')).toHaveLength(0);
    },
  );
});
