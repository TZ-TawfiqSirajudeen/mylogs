import { describe, expect, test } from 'vitest';
import { can, describeRule, duration, errorText, num } from './model';

const base = { condition: { op: 'gt' as const, threshold: 10 }, windowSeconds: 300, forSeconds: 120 };

describe('describeRule', () => {
  test('a metric rule reads as plain language', () => {
    expect(describeRule({ ...base, query: { kind: 'metric', metric: 'http.errors', agg: 'rate', filters: [], groupBy: ['service'], service: 'checkout' } }))
      .toBe('rate(http.errors @ checkout) by service > 10 over 5 min, for 2 min');
  });
  test('a log rule names what it counts and omits a zero for-duration', () => {
    expect(describeRule({ ...base, forSeconds: 0, windowSeconds: 3600, query: { kind: 'logs', filters: [], errorsOnly: true, text: 'timeout', services: ['api'] } }))
      .toBe('count of logs (errors) matching "timeout" in api > 10 over 1 h');
  });
});

describe('formatting helpers', () => {
  test('durations and numbers', () => {
    expect([duration(45), duration(60), duration(7200), duration(90)]).toEqual(['45 s', '1 min', '2 h', '90 s']);
    expect([num(null), num(3), num(0.123456), num(undefined)]).toEqual(['—', '3', '0.1235', '—']);
  });
  test('errorText shows the server message with field details, bounded', () => {
    const e = Object.assign(new Error('Request validation failed'), { details: [{ path: '/condition/threshold', message: 'must be finite' }, { path: '', message: 'oops' }] });
    expect(errorText(e)).toBe('Request validation failed — condition.threshold: must be finite; oops');
    expect(errorText(new Error('plain'))).toBe('plain');
    expect(errorText('not an error')).toBe('Something went wrong');
  });
  test('the UI only offers actions the role may perform (the server enforces the same rules)', () => {
    expect(can('viewer')).toEqual({ manage: false, act: false });
    expect(can('engineer')).toEqual({ manage: false, act: true });
    expect(can('project_admin')).toEqual({ manage: true, act: true });
    expect(can(undefined)).toEqual({ manage: false, act: false });
  });
});
