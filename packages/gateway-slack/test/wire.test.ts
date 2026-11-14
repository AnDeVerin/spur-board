import { describe, expect, it } from 'vitest';
import { parseRef } from '../src/ref.ts';
import { fieldsOf, itemsOf, messageTs, textOf } from '../src/wire.ts';

describe('gateway wire readers', () => {
  it('reads only non-empty text', () => {
    expect(textOf('')).toBeUndefined();
    expect(textOf('a')).toBe('a');
    expect(textOf(1)).toBeUndefined();
  });

  it('reads a message ts, the empty string included', () => {
    expect(messageTs({ ts: '' })).toBe('');
    expect(messageTs({ ts: '1.2' })).toBe('1.2');
    expect(messageTs({ ts: 1 })).toBeUndefined();
    expect(messageTs(null)).toBeUndefined();
    expect(messageTs([])).toBeUndefined();
  });

  it('treats only plain objects as fields and only arrays as items', () => {
    expect(fieldsOf([])).toBeNull();
    expect(fieldsOf(null)).toBeNull();
    expect(fieldsOf({ a: 1 })).toEqual({ a: 1 });
    expect(itemsOf({})).toBeNull();
    expect(itemsOf([1])).toEqual([1]);
  });

  it('parses a ref with empty fields and drops extra keys', () => {
    expect(parseRef('{"channel":"","ts":"","threadTs":""}')).toEqual({
      channel: '',
      ts: '',
      threadTs: '',
    });
    expect(parseRef('{"channel":"C1","ts":"1.2","threadTs":"1.1","extra":true}')).toStrictEqual({
      channel: 'C1',
      ts: '1.2',
      threadTs: '1.1',
    });
    expect(parseRef('{"channel":"C1","ts":1,"threadTs":"1.1"}')).toBeNull();
    expect(parseRef('not json')).toBeNull();
  });
});
