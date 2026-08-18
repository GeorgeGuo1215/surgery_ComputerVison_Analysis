import { describe, expect, it } from 'vitest';
import type { VitalReading } from './types';
import { buildOfflineAnalysisPlan, buildOfflineSampleSlots, consensusReading, formatMediaTime } from './offline';
import { evaluateReading } from './vitals';

function reading(display: string | null, confidence: number, status: VitalReading['status'] = 'ok'): VitalReading {
  return {
    key: 'hr',
    display,
    values: display == null ? [] : [Number(display)],
    rawText: display ?? '',
    confidence,
    status,
    capturedAt: '2026-08-17T08:00:00.000Z',
  };
}

describe('offline video sampling', () => {
  it.each([30, 60, 300])('uses five-frame HR-only consensus for a %d-second standard interval', (intervalSeconds) => {
    expect(buildOfflineAnalysisPlan(intervalSeconds)).toMatchObject({
      mode: 'hr-standard',
      metricKeys: ['hr'],
      consensusFrames: 5,
      frameSpacingSeconds: 0.5,
      snapshotBatchSize: 1,
    });
  });

  it('creates fixed slots for the supplied six-minute video without drifting', () => {
    const slots = buildOfflineSampleSlots(366.931, 60);
    expect(slots.map(({ mediaTimeSeconds }) => mediaTimeSeconds)).toEqual([0, 60, 120, 180, 240, 300, 360]);
    expect(slots.every(({ frameTimesSeconds }) => frameTimesSeconds.length === 5)).toBe(true);
  });

  it('creates exactly the 00:00 and 05:00 standard slots for the supplied video', () => {
    const slots = buildOfflineSampleSlots(366.931, 300);
    expect(slots.map(({ mediaTimeSeconds }) => mediaTimeSeconds)).toEqual([0, 300]);
    expect(slots.flatMap(({ frameTimesSeconds }) => frameTimesSeconds).every((time) => time >= 0 && time < 366.931)).toBe(true);
    expect(buildOfflineSampleSlots(300, 300).map(({ mediaTimeSeconds }) => mediaTimeSeconds)).toEqual([0]);
  });

  it('creates all 603 integer-second slots for the 10:02.333 reference video without duplicates or drift', () => {
    const durationSeconds = 602.333333;
    const plan = buildOfflineAnalysisPlan(1);
    const slots = buildOfflineSampleSlots(
      durationSeconds,
      1,
      plan.consensusFrames,
      plan.frameSpacingSeconds,
      plan.firstSlotCenterSeconds,
    );
    const mediaTimes = slots.map(({ mediaTimeSeconds }) => mediaTimeSeconds);

    expect(plan).toMatchObject({
      mode: 'hr-per-second',
      metricKeys: ['hr'],
      consensusFrames: 3,
      snapshotBatchSize: 25,
    });
    expect(slots).toHaveLength(603);
    expect(mediaTimes[0]).toBe(0);
    expect(mediaTimes.at(-1)).toBe(602);
    expect(new Set(mediaTimes).size).toBe(603);
    expect(mediaTimes).toEqual(Array.from({ length: 603 }, (_, index) => index));
    expect(slots.every(({ frameTimesSeconds }) => (
      frameTimesSeconds.length === 3
      && frameTimesSeconds.every((time) => time >= 0 && time < durationSeconds)
    ))).toBe(true);
    expect(slots.flatMap(({ frameTimesSeconds }) => frameTimesSeconds).every((time, index, all) => (
      index === 0 || time >= all[index - 1]
    ))).toBe(true);
    expect(slots.reduce((sum, slot) => sum + slot.frameTimesSeconds.length, 0)).toBe(1_809);
  });

  it('requires a strict two-of-three majority and the confidence threshold', () => {
    const accepted = consensusReading('hr', [reading('90', 91), reading('90', 87), reading('91', 95)], '2026-08-17T08:00:00.000Z');
    expect(accepted.status).toBe('ok');
    expect(accepted.display).toBe('90');

    const rejected = consensusReading('hr', [reading('90', 49), reading('90', 51), reading('91', 90)], '2026-08-17T08:00:00.000Z');
    expect(rejected.status).toBe('low-confidence');
  });

  it('requires three-of-five votes and does not accept a 2-2-1 tie', () => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const accepted = consensusReading('hr', [
      reading('90', 91),
      reading('90', 89),
      reading('90', 87),
      reading('91', 95),
      reading('92', 93),
    ], capturedAt);
    const tied = consensusReading('hr', [
      reading('90', 91),
      reading('90', 89),
      reading('91', 95),
      reading('91', 93),
      reading('92', 87),
    ], capturedAt);

    expect(accepted).toMatchObject({ display: '90', values: [90], status: 'ok' });
    expect(tied.status).toBe('low-confidence');
    expect(tied.reason).toMatch(/3\/5|严格多数/);
  });

  it('confirms a corrected candidate only when two direct-number frames form a two-of-three majority', () => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const corrected = evaluateReading('hr', '9O', 99, capturedAt);
    const directOne = evaluateReading('hr', '90', 99, capturedAt);
    const directTwo = evaluateReading('hr', '90', 98, capturedAt);

    expect(corrected.status).toBe('low-confidence');
    expect(consensusReading('hr', [corrected, directOne, directTwo], capturedAt)).toMatchObject({
      display: '90',
      values: [90],
      status: 'ok',
    });
  });

  it('does not let one corrected frame fill the missing second direct vote in a three-frame slot', () => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const corrected = evaluateReading('hr', '9O', 99, capturedAt);
    const direct = evaluateReading('hr', '90', 99, capturedAt);
    const missing = evaluateReading('hr', '---', 99, capturedAt);
    const consensus = consensusReading('hr', [direct, corrected, missing], capturedAt);

    expect(consensus.status).toBe('low-confidence');
    expect(consensus.reason).toMatch(/直接数字|2\/3|严格多数/);
  });

  it('requires three direct ok votes in a five-frame slot even when corrected candidates agree', () => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const direct = (confidence: number) => evaluateReading('hr', '90', confidence, capturedAt);
    const corrected = (confidence: number) => evaluateReading('hr', '9O', confidence, capturedAt);
    const missing = evaluateReading('hr', '---', 99, capturedAt);

    const onlyTwoDirect = consensusReading('hr', [
      direct(99),
      direct(98),
      corrected(97),
      corrected(96),
      missing,
    ], capturedAt);
    const threeDirect = consensusReading('hr', [
      direct(99),
      direct(98),
      direct(97),
      corrected(96),
      evaluateReading('hr', '91', 95, capturedAt),
    ], capturedAt);

    expect(onlyTwoDirect.status).toBe('low-confidence');
    expect(onlyTwoDirect.reason).toMatch(/直接数字|3\/5|严格多数/);
    expect(threeDirect).toMatchObject({ display: '90', values: [90], status: 'ok' });
  });

  it.each(['0', '4', '9'])('does not upgrade repeated single-digit HR %s to ok', (display) => {
    const guarded = consensusReading(
      'hr',
      [reading(display, 99, 'low-confidence'), reading(display, 98, 'low-confidence'), reading(display, 97, 'low-confidence')],
      '2026-08-17T08:00:00.000Z',
    );
    expect(guarded).toMatchObject({ display, values: [Number(display)], status: 'low-confidence' });
  });

  it.each([
    ['short majority', ['4', '4', '47']],
    ['long majority', ['47', '47', '7']],
  ] as const)('does not automatically choose the long or short value in a leading-digit conflict: %s', (_label, rawTexts) => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const guarded = consensusReading(
      'hr',
      rawTexts.map((rawText) => evaluateReading('hr', rawText, 99, capturedAt)),
      capturedAt,
    );

    expect(guarded).toMatchObject({ display: null, values: [], status: 'low-confidence' });
    expect(guarded.reason).toContain('前导数字');
  });

  it('formats offsets independently of local wall-clock time', () => {
    expect(formatMediaTime(0)).toBe('00:00');
    expect(formatMediaTime(366.931)).toBe('06:06');
    expect(formatMediaTime(3723)).toBe('01:02:03');
  });
});
