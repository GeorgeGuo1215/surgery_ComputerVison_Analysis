import { describe, expect, it } from 'vitest';
import type { ReadingStatus, VitalReading } from './types';
import { evaluateReading } from './vitals';
import {
  DEFAULT_HEART_RATE_STABILIZATION_CONFIG,
  createHeartRateStabilizationState,
  heartRateJumpThreshold,
  stabilizeHeartRateReading,
  type HeartRateStabilizationState,
} from './heartRateStabilization';

const capturedAt = '2026-08-18T08:00:00.000Z';

function reading(
  bpm: number,
  status: ReadingStatus = 'ok',
  at = capturedAt,
): VitalReading {
  return {
    key: 'hr',
    display: String(bpm),
    values: [bpm],
    rawText: String(bpm),
    confidence: 99,
    status,
    capturedAt: at,
  };
}

function acceptBaseline(bpm: number): HeartRateStabilizationState {
  const initial = stabilizeHeartRateReading(createHeartRateStabilizationState(), reading(bpm));
  expect(initial).toMatchObject({ outcome: 'accepted', acceptedBpm: bpm, candidateBpm: null });
  return initial.state;
}

describe('cross-slot HR jump confirmation', () => {
  it('centralizes the default 8 bpm / 15% jump threshold and ±2 confirmation tolerance', () => {
    expect(DEFAULT_HEART_RATE_STABILIZATION_CONFIG).toEqual({
      absoluteJumpBpm: 8,
      relativeJumpFraction: 0.15,
      confirmationToleranceBpm: 2,
    });
    expect(heartRateJumpThreshold(50)).toBe(8);
    expect(heartRateJumpThreshold(100)).toBe(15);
  });

  it('keeps 50 → 120 as a candidate without smoothing or forward-filling 50', () => {
    const state = acceptBaseline(50);
    const decision = stabilizeHeartRateReading(state, reading(120));

    expect(decision).toMatchObject({
      outcome: 'pending-confirmation',
      acceptedBpm: null,
      candidateBpm: 120,
      reading: { display: '120', values: [120], status: 'low-confidence' },
      state: { baselineBpm: 50, pendingJump: { bpm: 120 } },
    });
    expect(decision.reading.display).not.toBe('50');
    expect(decision.reason).toMatch(/下一连续槽|不前填/);
  });

  it('accepts the current 121, not an average, after 50 → 120 → 121 confirms the new baseline', () => {
    const firstJump = stabilizeHeartRateReading(acceptBaseline(50), reading(120));
    const confirmed = stabilizeHeartRateReading(firstJump.state, reading(121));

    expect(confirmed).toMatchObject({
      outcome: 'accepted',
      acceptedBpm: 121,
      candidateBpm: null,
      reading: { display: '121', values: [121], status: 'ok' },
      state: { baselineBpm: 121, pendingJump: null },
    });
    expect(confirmed.reason).toMatch(/确认|新基线|未取平均/);
  });

  it('does not confirm a spike in 50 → 120 → 50 and resumes from the real current 50', () => {
    const firstJump = stabilizeHeartRateReading(acceptBaseline(50), reading(120));
    const returned = stabilizeHeartRateReading(firstJump.state, reading(50));

    expect(returned).toMatchObject({
      outcome: 'accepted',
      acceptedBpm: 50,
      reading: { display: '50', values: [50], status: 'ok' },
      state: { baselineBpm: 50, pendingJump: null },
    });
    expect(returned.acceptedBpm).not.toBe(120);
  });

  it('accepts gradual changes directly and emits each observed value unchanged', () => {
    let state = createHeartRateStabilizationState();
    for (const bpm of [50, 58, 66, 75]) {
      const decision = stabilizeHeartRateReading(state, reading(bpm));
      expect(decision).toMatchObject({
        outcome: 'accepted',
        acceptedBpm: bpm,
        reading: { display: String(bpm), values: [bpm] },
        state: { baselineBpm: bpm, pendingJump: null },
      });
      state = decision.state;
    }
  });

  it('never fills a missing slot and breaks a pending confirmation sequence', () => {
    const pending = stabilizeHeartRateReading(acceptBaseline(50), reading(120));
    const missing = evaluateReading('hr', '---', 99, capturedAt);
    const decision = stabilizeHeartRateReading(pending.state, missing);

    expect(decision).toMatchObject({
      outcome: 'rejected',
      acceptedBpm: null,
      candidateBpm: null,
      reading: { display: null, values: [], status: 'not-found' },
      state: { baselineBpm: 50, pendingJump: null },
    });
    expect(decision.reason).toMatch(/缺失|不前填|中断/);
  });

  it('never fills or accepts an out-of-range value', () => {
    const outside = evaluateReading('hr', '201', 99, capturedAt);
    const decision = stabilizeHeartRateReading(acceptBaseline(50), outside);

    expect(decision).toMatchObject({
      outcome: 'rejected',
      acceptedBpm: null,
      candidateBpm: 201,
      reading: { display: '201', values: [201], status: 'out-of-range' },
      state: { baselineBpm: 50, pendingJump: null },
    });
    expect(decision.reason).toMatch(/超出 0–200|不前填/);
  });

  it('keeps a single-character automatic OCR result review-only and does not start jump confirmation', () => {
    const singleCharacter = evaluateReading('hr', '4', 99, capturedAt);
    const decision = stabilizeHeartRateReading(acceptBaseline(50), singleCharacter);

    expect(decision).toMatchObject({
      outcome: 'rejected',
      acceptedBpm: null,
      candidateBpm: 4,
      reading: { display: '4', values: [4], status: 'low-confidence' },
      state: { baselineBpm: 50, pendingJump: null },
    });
    expect(decision.reason).toMatch(/仅保留候选|不更新基线|不前填/);
  });

  it('accepts the inclusive 0 and 200 boundaries when the incoming reading is itself reliable', () => {
    const confirmedZero = stabilizeHeartRateReading(
      createHeartRateStabilizationState(),
      reading(0, 'manual-corrected'),
    );
    const upperBoundary = stabilizeHeartRateReading(
      createHeartRateStabilizationState(),
      reading(200),
    );

    expect(confirmedZero).toMatchObject({ outcome: 'accepted', acceptedBpm: 0, state: { baselineBpm: 0 } });
    expect(upperBoundary).toMatchObject({ outcome: 'accepted', acceptedBpm: 200, state: { baselineBpm: 200 } });
  });

  it('can use a tighter or looser threshold without changing the state-machine contract', () => {
    const state = acceptBaseline(50);
    expect(stabilizeHeartRateReading(state, reading(60)).outcome).toBe('pending-confirmation');
    expect(stabilizeHeartRateReading(state, reading(60), { absoluteJumpBpm: 10 }).outcome).toBe('accepted');
  });
});
