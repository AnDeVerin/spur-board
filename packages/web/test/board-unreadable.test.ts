// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { createBoardData } from '../src/board/data.ts';
import { daemon, envelope, failure } from './board-fixtures.ts';
import { mount, mounted, mountEachTest, one, settle } from './board-harness.ts';

mountEachTest();

const bogus = () => Promise.resolve(envelope({ bogus: true }));
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

describe('unreadable daemon answers', () => {
  it('a schema failure on a 2xx answer is unreadable, a failed request is not', async () => {
    const d = daemon();
    const data = createBoardData({
      fetch: d.fetcher,
      storage: () => ({ getItem: () => null, setItem: () => undefined }),
      now: () => 0,
    });
    data.start();
    await settle();
    expect(data.snapshot()).toMatchObject({ readFailed: false, unreadable: false });
    const reread = async () => {
      data.retry();
      await settle();
      return data.snapshot();
    };
    d.routes['status.get'] = bogus;
    expect(await reread()).toMatchObject({ readFailed: true, unreadable: true });
    d.routes['status.get'] = failure;
    expect(await reread()).toMatchObject({ readFailed: true, unreadable: false });
    d.routes['status.get'] = offline;
    expect(await reread()).toMatchObject({ readFailed: true, unreadable: false });
    // Mixed causes: a network failure on config is not hidden by an unreadable status.
    d.routes['config.get'] = offline;
    d.routes['status.get'] = bogus;
    expect(await reread()).toMatchObject({ readFailed: true, unreadable: false });
    d.routes['config.get'] = bogus;
    expect(await reread()).toMatchObject({ readFailed: true, unreadable: true });
    data.stop();
  });

  it('an unreadable answer has its own banner and task view hint', async () => {
    history.replaceState(null, '', '/?open=ex%2Frepo%237');
    const d = daemon();
    mount(d);
    await settle();
    d.routes['status.get'] = bogus;
    d.routes['config.get'] = bogus;
    act(() => {
      mounted().retry();
    });
    await settle();
    const alert = one('[role="alert"]').textContent;
    expect(alert).toContain("The board daemon's answer could not be read.");
    expect(alert).not.toContain('does not answer');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "The board daemon's answer could not be read. Answers and comments cannot be sent.",
    );
  });
});
