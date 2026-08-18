import { describe, expect, it } from 'vitest';
import { consensusReading } from './offline';
import type { VitalKey, VitalReading } from './types';
import { evaluateReading } from './vitals';

interface ObservedCandidate {
  rawText: string;
  confidence: number;
}

const REAL_VIDEO_FIXTURE = {
  t0: {
    capturedAt: '2026-08-17T08:00:00.000Z',
    hr: [
      { rawText: '90', confidence: 93 },
      { rawText: '9O', confidence: 88 },
      { rawText: '91', confidence: 84 },
    ],
  },
  t280: {
    capturedAt: '2026-08-17T08:04:40.000Z',
    hr: [{ rawText: '85', confidence: 94 }],
  },
  t300: {
    capturedAt: '2026-08-17T08:05:00.000Z',
    hr: [
      { rawText: '---', confidence: 96 },
      { rawText: '— — —', confidence: 91 },
      { rawText: '', confidence: 0 },
    ],
    rr: [
      { rawText: '3', confidence: 91 },
      { rawText: '3', confidence: 88 },
      { rawText: '13', confidence: 42 },
    ],
    pr: [
      { rawText: '86', confidence: 92 },
      { rawText: '86', confidence: 89 },
      { rawText: '85', confidence: 87 },
    ],
  },
} as const;

function evaluateCandidates(
  key: VitalKey,
  candidates: readonly ObservedCandidate[],
  capturedAt: string,
  recentAccepted: VitalReading[] = [],
): VitalReading[] {
  return candidates.map(({ rawText, confidence }) => (
    evaluateReading(key, rawText, confidence, capturedAt, recentAccepted)
  ));
}

describe('real Mindray iMEC8 video OCR fixture', () => {
  it('keeps the t=0 HR candidate pending when its second agreeing frame required character correction', () => {
    const fixture = REAL_VIDEO_FIXTURE.t0;
    const reading = consensusReading(
      'hr',
      evaluateCandidates('hr', fixture.hr, fixture.capturedAt),
      fixture.capturedAt,
    );

    expect(reading).toMatchObject({
      key: 'hr',
      display: '90',
      values: [90],
      status: 'low-confidence',
    });
    expect(reading.reason).toMatch(/直接数字|2\/3|严格多数/);
  });

  it('records t=300 HR as missing instead of carrying the previous 85 forward', () => {
    const previousFixture = REAL_VIDEO_FIXTURE.t280;
    const previous = evaluateReading(
      'hr',
      previousFixture.hr[0].rawText,
      previousFixture.hr[0].confidence,
      previousFixture.capturedAt,
    );
    const fixture = REAL_VIDEO_FIXTURE.t300;
    const candidates = evaluateCandidates('hr', fixture.hr, fixture.capturedAt, [previous]);
    const reading = consensusReading('hr', candidates, fixture.capturedAt);

    expect(previous.display).toBe('85');
    expect(candidates.every(({ display, status }) => display === null && status === 'not-found')).toBe(true);
    expect(reading).toMatchObject({
      key: 'hr',
      display: null,
      values: [],
      status: 'not-found',
    });
  });

  it('keeps the complete RR=13 candidate for the observed 3/13 leading-digit conflict', () => {
    const fixture = REAL_VIDEO_FIXTURE.t300;
    const reading = consensusReading(
      'rr',
      evaluateCandidates('rr', fixture.rr, fixture.capturedAt),
      fixture.capturedAt,
    );

    expect(reading).toMatchObject({
      key: 'rr',
      display: '13',
      values: [13],
      status: 'low-confidence',
    });
    expect(reading.reason).toContain('前导数字');
  });

  it('keeps SpO2-derived PR independent when ECG HR is unavailable at t=300', () => {
    const fixture = REAL_VIDEO_FIXTURE.t300;
    const hr = consensusReading(
      'hr',
      evaluateCandidates('hr', fixture.hr, fixture.capturedAt),
      fixture.capturedAt,
    );
    const pr = consensusReading(
      'pr',
      evaluateCandidates('pr', fixture.pr, fixture.capturedAt),
      fixture.capturedAt,
    );

    expect(hr).toMatchObject({ key: 'hr', display: null, status: 'not-found' });
    expect(pr).toMatchObject({ key: 'pr', display: '86', values: [86], status: 'ok' });
  });
});
