import { isScrubbed } from '@spur-board/testkit';
import { expect, it } from 'vitest';
import { assertNever } from '../src/index.ts';

it('throws with the unexpected value in the message', () => {
  expect(() => assertNever('surprise' as never)).toThrow('Unexpected value: "surprise"');
});

it('resolves workspace packages from tests', () => {
  expect(isScrubbed('SPUR_SESSION')).toBe(true);
});
