import type { VitalReading } from './types';
import { isAcceptedHeartRateReading } from './vitals';

export interface HeartRateStabilizationConfig {
  /** Always allow changes up to this many bpm. */
  absoluteJumpBpm: number;
  /** Also allow changes up to this fraction of the current baseline. */
  relativeJumpFraction: number;
  /** Two consecutive large-jump observations may differ by at most this amount. */
  confirmationToleranceBpm: number;
}

export const DEFAULT_HEART_RATE_STABILIZATION_CONFIG: Readonly<HeartRateStabilizationConfig> = Object.freeze({
  absoluteJumpBpm: 8,
  relativeJumpFraction: 0.15,
  confirmationToleranceBpm: 2,
});

export interface PendingHeartRateJump {
  bpm: number;
  capturedAt: string;
}

/**
 * Baseline is comparison-only state. Callers must never emit it when the
 * current decision has no accepted value.
 */
export interface HeartRateStabilizationState {
  baselineBpm: number | null;
  pendingJump: PendingHeartRateJump | null;
}

export type HeartRateStabilizationOutcome =
  | 'accepted'
  | 'pending-confirmation'
  | 'rejected';

export interface HeartRateStabilizationDecision {
  outcome: HeartRateStabilizationOutcome;
  /** Current observed value only. Null means this slot has no accepted HR. */
  acceptedBpm: number | null;
  /** Current review candidate, if the input contained one. */
  candidateBpm: number | null;
  /** Reading safe to store for this slot; it is never replaced by the baseline. */
  reading: VitalReading;
  state: HeartRateStabilizationState;
  reason: string;
}

export function createHeartRateStabilizationState(
  baselineBpm: number | null = null,
): HeartRateStabilizationState {
  if (
    baselineBpm != null
    && (!Number.isInteger(baselineBpm) || baselineBpm < 0 || baselineBpm > 200)
  ) {
    throw new RangeError('HR stabilization baseline must be an integer from 0 to 200 bpm');
  }
  return { baselineBpm, pendingJump: null };
}

function resolveConfig(
  overrides: Partial<HeartRateStabilizationConfig>,
): HeartRateStabilizationConfig {
  const config = { ...DEFAULT_HEART_RATE_STABILIZATION_CONFIG, ...overrides };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Invalid HR stabilization config: ${key}`);
    }
  }
  return config;
}

export function heartRateJumpThreshold(
  baselineBpm: number,
  overrides: Partial<HeartRateStabilizationConfig> = {},
): number {
  const config = resolveConfig(overrides);
  return Math.max(config.absoluteJumpBpm, Math.abs(baselineBpm) * config.relativeJumpFraction);
}

function currentCandidateBpm(reading: VitalReading): number | null {
  if (reading.key !== 'hr' || reading.values.length !== 1) return null;
  const value = reading.values[0];
  return Number.isFinite(value) ? value : null;
}

function readingWithReason(
  reading: VitalReading,
  reason: string,
  status: VitalReading['status'] = reading.status,
): VitalReading {
  return {
    ...reading,
    status,
    reason: reading.reason ? `${reason}；输入判定：${reading.reason}` : reason,
  };
}

function acceptedDecision(
  reading: VitalReading,
  bpm: number,
  reason: string,
): HeartRateStabilizationDecision {
  return {
    outcome: 'accepted',
    acceptedBpm: bpm,
    candidateBpm: null,
    reading: readingWithReason(reading, reason),
    state: { baselineBpm: bpm, pendingJump: null },
    reason,
  };
}

/**
 * Applies cross-slot jump confirmation to one already parsed HR reading.
 *
 * The function is source-agnostic (camera and imported-video slots use the
 * same API), immutable, and intentionally performs no averaging, smoothing,
 * interpolation, or forward fill.
 */
export function stabilizeHeartRateReading(
  state: HeartRateStabilizationState,
  reading: VitalReading,
  overrides: Partial<HeartRateStabilizationConfig> = {},
): HeartRateStabilizationDecision {
  const config = resolveConfig(overrides);
  const candidateBpm = currentCandidateBpm(reading);

  if (!isAcceptedHeartRateReading(reading)) {
    const reason = reading.status === 'not-found' || reading.display == null
      ? `当前槽 HR 缺失（${reading.status}），不接受、不前填，连续跳变确认已中断`
      : reading.status === 'out-of-range'
        ? '当前槽 HR 超出 0–200 bpm，不接受、不前填，连续跳变确认已中断'
        : `当前槽 HR 不是可靠读数（${reading.status}），仅保留候选，不更新基线、不前填`;
    return {
      outcome: 'rejected',
      acceptedBpm: null,
      candidateBpm,
      reading: readingWithReason(reading, reason),
      state: { baselineBpm: state.baselineBpm, pendingJump: null },
      reason,
    };
  }

  const bpm = reading.values[0];
  if (state.baselineBpm == null) {
    const reason = `首个可靠 HR ${bpm} bpm 建立比较基线，直接接受当前实测值；未平滑、未前填`;
    return acceptedDecision(reading, bpm, reason);
  }

  if (
    state.pendingJump
    && Math.abs(bpm - state.pendingJump.bpm) <= config.confirmationToleranceBpm
  ) {
    const reason = `HR ${bpm} bpm 与上一槽待确认值 ${state.pendingJump.bpm} bpm 相差不超过 ±${config.confirmationToleranceBpm}，接受当前实测值为新基线；未取平均`;
    return acceptedDecision(reading, bpm, reason);
  }

  const jump = Math.abs(bpm - state.baselineBpm);
  const threshold = heartRateJumpThreshold(state.baselineBpm, config);
  if (jump <= threshold) {
    const reason = `HR ${bpm} bpm 相对基线 ${state.baselineBpm} bpm 变化 ${jump} bpm，不超过 ${threshold} bpm 阈值，直接接受当前实测值；未平滑`;
    return acceptedDecision(reading, bpm, reason);
  }

  const reason = state.pendingJump
    ? `HR ${bpm} bpm 与待确认值 ${state.pendingJump.bpm} bpm 不在 ±${config.confirmationToleranceBpm} 内，且相对基线 ${state.baselineBpm} bpm 的变化 ${jump} bpm 超过 ${threshold} bpm；本槽作为新的待确认候选，不前填`
    : `HR ${bpm} bpm 相对基线 ${state.baselineBpm} bpm 的变化 ${jump} bpm 超过 ${threshold} bpm；需下一连续槽在 ±${config.confirmationToleranceBpm} 内确认，本槽不作为可靠值且不前填`;
  return {
    outcome: 'pending-confirmation',
    acceptedBpm: null,
    candidateBpm: bpm,
    reading: readingWithReason(reading, reason, 'low-confidence'),
    state: {
      baselineBpm: state.baselineBpm,
      pendingJump: { bpm, capturedAt: reading.capturedAt },
    },
    reason,
  };
}
