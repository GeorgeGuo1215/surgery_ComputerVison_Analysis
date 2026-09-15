import type { ReadingMap, RecordSnapshot } from './types';
import { ACTIVE_VITAL_KEYS, isAcceptedVitalReading } from './vitals';

export function calculateSnapshotQuality(readings: ReadingMap): RecordSnapshot['quality'] {
  const okCount = ACTIVE_VITAL_KEYS.filter((key) => (
    isAcceptedVitalReading(readings[key])
  )).length;
  if (okCount === ACTIVE_VITAL_KEYS.length) return 'complete';
  const hasReviewCandidate = ACTIVE_VITAL_KEYS.some((key) => (
    readings[key].display != null
    || readings[key].status === 'low-confidence'
    || readings[key].status === 'out-of-range'
  ));
  if (okCount === 0 && !hasReviewCandidate) return 'missing';
  return 'review';
}

export function createSnapshot(
  readings: ReadingMap,
  source: RecordSnapshot['source'],
  recordedAt = new Date().toISOString(),
  scheduledAt = recordedAt,
  details: Pick<RecordSnapshot, 'inputSource' | 'mediaTimeSeconds' | 'sourceFileName' | 'videoStartAt' | 'analyzedAt' | 'analysisRunId'> = {},
): RecordSnapshot {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    scheduledAt,
    recordedAt,
    source,
    ...details,
    readings: structuredClone(readings),
    quality: calculateSnapshotQuality(readings),
    verified: false,
    note: '',
    audit: [],
  };
}

export function millisecondsUntilNextRecord(
  startedAt: string,
  lastRecordedAt: string | null,
  intervalMinutes: number,
  now = Date.now(),
): number {
  const anchor = lastRecordedAt ? Date.parse(lastRecordedAt) : Date.parse(startedAt);
  if (!Number.isFinite(anchor) || intervalMinutes <= 0) return 0;
  return Math.max(0, anchor + intervalMinutes * 60_000 - now);
}
