import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Meter, type MeterThresholds } from '../src/ds/index.ts';

describe('Meter', () => {
  const low: MeterThresholds = { warn: 0.2, error: 0.05, worse: 'low' };
  const render = (value: number | null, limit = 5000, thresholds: MeterThresholds | null = low) =>
    renderToStaticMarkup(
      createElement(Meter, { name: 'Budget', value, limit, thresholds: thresholds ?? undefined }),
    );

  it('draws an ok reading with its bar, label and meter attributes', () => {
    const html = render(4210);
    expect(html).toContain('data-level="ok"');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-label="Budget"');
    expect(html).toContain('aria-valuetext="4210 / 5000"');
    expect(html).toContain('aria-valuenow="4210"');
    expect(html).toContain('width:84%');
    expect(html).toContain('4210 / 5000');
    expect(html).not.toContain('warning');
  });

  it.each([
    [1000, 'warning'],
    [900, 'warning'],
    [250, 'error'],
    [150, 'error'],
  ])('switches at inclusive thresholds when low is worse: %d is %s', (value, level) => {
    const html = render(value);
    expect(html).toContain(`data-level="${level}"`);
    expect(html).toContain(`aria-valuetext="${String(value)} / 5000 · ${level}"`);
    expect(html).toContain(`· ${level}</span>`);
  });

  it('switches when high is worse', () => {
    const high: MeterThresholds = { warn: 0.8, error: 0.9, worse: 'high' };
    expect(render(92, 100, high)).toContain('data-level="error"');
    expect(render(85, 100, high)).toContain('data-level="warning"');
    expect(render(79, 100, high)).toContain('data-level="ok"');
  });

  it('stays ok without thresholds', () => {
    expect(render(1, 5000, null)).toContain('data-level="ok"');
  });

  it('clamps the fill and the value but keeps the reading', () => {
    const html = render(6000);
    expect(html).toContain('width:100%');
    expect(html).toContain('aria-valuenow="5000"');
    expect(html).toContain('aria-valuetext="6000 / 5000"');
  });

  it.each([
    ['a null value', null, 5000, '5000'],
    ['a zero limit', 10, 0, '0'],
    ['a NaN value', Number.NaN, 5000, '5000'],
    ['an infinite value', Number.POSITIVE_INFINITY, 5000, '5000'],
    ['a NaN limit', 10, Number.NaN, '—'],
    ['an infinite limit', 10, Number.POSITIVE_INFINITY, '—'],
  ])('draws no reading for %s', (_, value, limit, max) => {
    const html = render(value, limit);
    expect(html).toContain('data-level="unknown"');
    expect(html).toContain('role="img"');
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain('aria-valuenow');
    expect(html).not.toContain('width:');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
    expect(html).toContain(`— / ${max}`);
    expect(html).toContain(`aria-label="Budget: unknown / ${max}"`);
  });
});
