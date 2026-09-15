import { describe, expect, it } from 'vitest';
import { calculateSnapshotQuality, createSnapshot, millisecondsUntilNextRecord } from './recording';
import { emptyReadingMap, formatDemoReading } from './vitals';

describe('fixed-slot recording', () => {
  it('anchors the next record to the previous fixed slot', () => {
    const start = '2026-08-17T08:00:00.000Z';
    const last = '2026-08-17T08:05:00.000Z';
    const now = Date.parse('2026-08-17T08:07:30.000Z');
    expect(millisecondsUntilNextRecord(start, last, 5, now)).toBe(150_000);
  });

  it('keeps scheduled time separate from actual write time', () => {
    const readings = emptyReadingMap();
    const row = createSnapshot(
      readings,
      'scheduled',
      '2026-08-17T08:05:03.000Z',
      '2026-08-17T08:05:00.000Z',
    );
    expect(row.scheduledAt).toBe('2026-08-17T08:05:00.000Z');
    expect(row.recordedAt).toBe('2026-08-17T08:05:03.000Z');
  });

  it('requires reliable HR and RR, ignoring deferred fields', () => {
    const timestamp = '2026-08-17T08:00:00.000Z';
    const readings = emptyReadingMap(timestamp);
    readings.hr = formatDemoReading('hr', [90], timestamp);
    readings.spo2 = { ...readings.spo2, status: 'not-found' };

    expect(calculateSnapshotQuality(readings)).toBe('review');
    readings.rr = formatDemoReading('rr', [18], timestamp);
    expect(calculateSnapshotQuality(readings)).toBe('complete');

    readings.hr.status = 'manual-corrected';
    expect(calculateSnapshotQuality(readings)).toBe('complete');

    readings.hr = { ...readings.hr, display: null, values: [], status: 'not-found' };
    expect(calculateSnapshotQuality(readings)).toBe('review');
    readings.rr = { ...readings.rr, display: null, values: [], status: 'not-found' };
    expect(calculateSnapshotQuality(readings)).toBe('missing');
  });
});
