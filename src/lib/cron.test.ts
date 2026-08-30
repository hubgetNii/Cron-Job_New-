import { describe, expect, it } from 'vitest';
import {
  assertValidCron,
  InvalidCronError,
  intervalSeconds,
  nextSlot,
  slotsBetween,
} from './cron.js';

describe('cron helpers', () => {
  it('accepts standard and 6-field expressions', () => {
    expect(() => assertValidCron('*/1 * * * *')).not.toThrow();
    expect(() => assertValidCron('*/30 * * * * *')).not.toThrow();
    expect(() => assertValidCron('0 9 * * 1-5')).not.toThrow();
  });

  it('rejects nonsense', () => {
    expect(() => assertValidCron('not a cron')).toThrow(InvalidCronError);
    expect(() => assertValidCron('99 99 99 99 99')).toThrow(InvalidCronError);
  });

  it('anchors the next slot to the wall-clock boundary', () => {
    const from = new Date('2026-08-30T13:00:37.500Z');
    expect(nextSlot('*/1 * * * *', from).toISOString()).toBe('2026-08-30T13:01:00.000Z');
    expect(nextSlot('*/5 * * * *', from).toISOString()).toBe('2026-08-30T13:05:00.000Z');
  });

  it('derives the interval in seconds', () => {
    expect(intervalSeconds('*/1 * * * *')).toBe(60);
    expect(intervalSeconds('*/5 * * * *')).toBe(300);
    expect(intervalSeconds('*/30 * * * * *')).toBe(30);
  });

  it('lists every slot in a range', () => {
    const after = new Date('2026-08-30T13:00:00.000Z');
    const until = new Date('2026-08-30T13:03:00.000Z');
    const slots = slotsBetween('*/1 * * * *', after, until).map((d) => d.toISOString());
    expect(slots).toEqual([
      '2026-08-30T13:01:00.000Z',
      '2026-08-30T13:02:00.000Z',
      '2026-08-30T13:03:00.000Z',
    ]);
  });
});
