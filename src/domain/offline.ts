import type { ReadingStatus, VitalKey, VitalReading } from './types';
import { ACTIVE_VITAL_KEYS } from './vitals';

export interface OfflineAnalysisPlan {
  mode: 'hr-standard' | 'hr-per-second';
  metricKeys: VitalKey[];
  consensusFrames: number;
  frameSpacingSeconds: number;
  firstSlotCenterSeconds: number;
  snapshotBatchSize: number;
}

export function buildOfflineAnalysisPlan(intervalSeconds: number): OfflineAnalysisPlan {
  if (intervalSeconds === 1) {
    return {
      mode: 'hr-per-second',
      metricKeys: [...ACTIVE_VITAL_KEYS],
      consensusFrames: 3,
      frameSpacingSeconds: 0.16,
      firstSlotCenterSeconds: 0.32,
      snapshotBatchSize: 25,
    };
  }
  return {
    mode: 'hr-standard',
    metricKeys: [...ACTIVE_VITAL_KEYS],
    consensusFrames: 5,
    frameSpacingSeconds: 0.5,
    firstSlotCenterSeconds: 0.65,
    snapshotBatchSize: 1,
  };
}

export interface OfflineSampleSlot {
  mediaTimeSeconds: number;
  frameTimesSeconds: number[];
}

export function buildOfflineSampleSlots(
  durationSeconds: number,
  intervalSeconds: number,
  consensusFrames = 5,
  frameSpacingSeconds = 0.5,
  firstSlotCenterSeconds = 0.65,
): OfflineSampleSlot[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return [];
  if (!Number.isInteger(consensusFrames) || consensusFrames <= 0) return [];
  if (!Number.isFinite(frameSpacingSeconds) || frameSpacingSeconds < 0) return [];
  if (!Number.isFinite(firstSlotCenterSeconds) || firstSlotCenterSeconds < 0) return [];
  const maximumTime = Math.max(0, durationSeconds - 0.05);
  const slots: OfflineSampleSlot[] = [];
  for (let mediaTimeSeconds = 0; mediaTimeSeconds <= maximumTime; mediaTimeSeconds += intervalSeconds) {
    const centered = mediaTimeSeconds === 0 ? firstSlotCenterSeconds : mediaTimeSeconds;
    const offsets = consensusFrames === 1 ? [0] : Array.from(
      { length: consensusFrames },
      (_, index) => (index - (consensusFrames - 1) / 2) * frameSpacingSeconds,
    );
    const frameTimesSeconds = [...new Set(offsets.map((offset) => (
      Math.round(Math.min(maximumTime, Math.max(0, centered + offset)) * 100) / 100
    )))];
    slots.push({ mediaTimeSeconds, frameTimesSeconds });
  }
  return slots;
}

const rejectedStatuses = new Set<ReadingStatus>(['not-found', 'not-configured', 'out-of-range']);

export function consensusReading(
  key: VitalKey,
  candidates: VitalReading[],
  capturedAt: string,
): VitalReading {
  const groups = new Map<string, VitalReading[]>();
  for (const candidate of candidates) {
    if (candidate.display == null || rejectedStatuses.has(candidate.status)) continue;
    groups.set(candidate.display, [...(groups.get(candidate.display) ?? []), candidate]);
  }

  const selected = [...groups.entries()]
    .sort((left, right) => {
      if (right[1].length !== left[1].length) return right[1].length - left[1].length;
      const leftConfidence = Math.max(...left[1].map(({ confidence }) => confidence));
      const rightConfidence = Math.max(...right[1].map(({ confidence }) => confidence));
      return rightConfidence - leftConfidence;
    })[0];

  if (!selected) {
    const outOfRangeCandidates = candidates.filter((candidate) => (
      candidate.status === 'out-of-range' && candidate.display != null
    ));
    const outOfRangeDisplays = [...new Set(outOfRangeCandidates.map(({ display }) => display))];
    if (outOfRangeDisplays.length === 1) {
      const strongest = [...outOfRangeCandidates].sort((left, right) => right.confidence - left.confidence)[0];
      return {
        ...strongest,
        status: 'out-of-range',
        capturedAt,
        rawText: candidates.map(({ rawText }) => rawText).filter(Boolean).join(' | '),
        reason: key === 'hr'
          ? '多帧后处理候选仍超出 HR 0–200 bpm 范围'
          : '多帧后处理候选仍超出设备捕获范围',
      };
    }
    return {
      key,
      display: null,
      values: [],
      rawText: candidates.map(({ rawText }) => rawText).filter(Boolean).join(' | '),
      confidence: candidates.length > 0 ? Math.max(...candidates.map(({ confidence }) => confidence)) : 0,
      status: 'not-found',
      capturedAt,
      reason: '离线采样帧均未得到可解析读数',
    };
  }

  let [selectedDisplay, agreeing] = selected;
  const displays = [...groups.keys()];
  const hasLeadingDigitConflict = displays.some((display, index) => (
    displays.slice(index + 1).some((other) => (
      display.startsWith(other)
      || other.startsWith(display)
      || display.endsWith(other)
      || other.endsWith(display)
    ))
  ));
  if (!ACTIVE_VITAL_KEYS.includes(key) && hasLeadingDigitConflict) {
    const mostComplete = [...groups.entries()]
      .sort((left, right) => right[0].length - left[0].length)[0];
    if (mostComplete) [selectedDisplay, agreeing] = mostComplete;
  }
  if (ACTIVE_VITAL_KEYS.includes(key) && hasLeadingDigitConflict) {
    return {
      key,
      display: null,
      values: [],
      rawText: candidates.map(({ rawText }) => rawText).filter(Boolean).join(' | '),
      confidence: Math.max(...candidates.map(({ confidence }) => confidence)),
      status: 'low-confidence',
      capturedAt,
      reason: '采样帧存在可能漏掉前导数字或尾随数字的冲突，不自动选择长值或短值',
    };
  }
  const strongest = [...agreeing].sort((left, right) => right.confidence - left.confidence)[0];
  const averageConfidence = agreeing.reduce((sum, reading) => sum + reading.confidence, 0) / agreeing.length;
  const reliableAgreeing = agreeing.filter(({ status }) => status === 'ok');
  const requiredVotes = Math.floor(candidates.length / 2) + 1;
  const stable = !hasLeadingDigitConflict
    && agreeing.length >= requiredVotes
    && reliableAgreeing.length >= requiredVotes
    && averageConfidence >= 65;
  return {
    ...strongest,
    confidence: averageConfidence,
    status: stable ? 'ok' : 'low-confidence',
    capturedAt,
    rawText: candidates.map(({ rawText }) => rawText).filter(Boolean).join(' | '),
    reason: stable
      ? `离线 ${agreeing.length} 帧一致（${agreeing.length}/${candidates.length} 严格多数）`
      : hasLeadingDigitConflict
        ? '采样帧存在可能漏掉前导数字的冲突，不自动选择长值或短值'
        : `离线采样未达到 ${requiredVotes}/${candidates.length} 帧严格多数、直接数字或 65% 置信度门槛`,
  };
}

export function formatMediaTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}
