import { calculateSnapshotQuality } from '../domain/recording';
import type { ReadingMap, RecordSnapshot, SessionState, VitalReading } from '../domain/types';
import { normalizeMedicationState } from '../domain/medications';
import {
  DEFAULT_ROIS,
  HEART_RATE_CAPTURE_RANGE,
  VITAL_KEYS,
  emptyReadingMap,
  isAcceptedHeartRateReading,
} from '../domain/vitals';

export const SESSION_STORAGE_KEY = 'petor-monitor/session-v2';
export const LEGACY_SESSION_STORAGE_KEY = 'petor-monitor/session-v1';
const CURRENT_SESSION_VERSION = 2 as const;

export type SaveSessionFailureCode =
  | 'storage-unavailable'
  | 'serialization-failed'
  | 'quota-exceeded'
  | 'write-failed';

export type SaveSessionResult =
  | {
      ok: true;
      key: typeof SESSION_STORAGE_KEY;
      version: typeof CURRENT_SESSION_VERSION;
    }
  | {
      ok: false;
      key: typeof SESSION_STORAGE_KEY;
      version: typeof CURRENT_SESSION_VERSION;
      code: SaveSessionFailureCode;
      errorName: string;
      message: string;
    };

type PersistedSnapshot = Omit<Partial<RecordSnapshot>, 'readings'> & {
  readings?: Partial<ReadingMap> | null;
};

type PersistedSession = Omit<Partial<SessionState>, 'snapshots'> & {
  snapshots?: PersistedSnapshot[];
};

function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeReadings(
  readings: Partial<ReadingMap> | null | undefined,
  capturedAt: string,
): ReadingMap {
  const normalized = emptyReadingMap(capturedAt);
  if (!isRecord(readings)) return normalized;

  for (const key of VITAL_KEYS) {
    const candidate = readings[key];
    if (!isRecord(candidate)) continue;
    normalized[key] = {
      ...normalized[key],
      ...(candidate as Partial<VitalReading>),
      key,
    };
  }

  const heartRate = normalized.hr;
  if (
    (heartRate.status === 'ok' || heartRate.status === 'manual-corrected')
    && !isAcceptedHeartRateReading(heartRate)
  ) {
    const onlyValue = heartRate.values.length === 1 ? heartRate.values[0] : null;
    const outsideRange = onlyValue != null && (
      !Number.isInteger(onlyValue)
      || onlyValue < HEART_RATE_CAPTURE_RANGE.min
      || onlyValue > HEART_RATE_CAPTURE_RANGE.max
    );
    normalized.hr = {
      ...heartRate,
      status: outsideRange ? 'out-of-range' : 'low-confidence',
      reason: outsideRange
        ? '历史草稿中的 HR 超出当前 0–200 bpm 整数范围，已降级为候选'
        : '历史草稿中的 HR 不满足当前可靠值规则，已降级为候选',
    };
  }
  return normalized;
}

function normalizeSnapshot(snapshot: PersistedSnapshot): RecordSnapshot {
  const recordedAt = typeof snapshot.recordedAt === 'string'
    ? snapshot.recordedAt
    : typeof snapshot.scheduledAt === 'string'
      ? snapshot.scheduledAt
      : new Date(0).toISOString();
  const scheduledAt = typeof snapshot.scheduledAt === 'string' ? snapshot.scheduledAt : recordedAt;
  const readings = normalizeReadings(snapshot.readings, recordedAt);

  return {
    ...(snapshot as RecordSnapshot),
    recordedAt,
    scheduledAt,
    readings,
    quality: calculateSnapshotQuality(readings),
    audit: Array.isArray(snapshot.audit) ? snapshot.audit : [],
  };
}

function normalizeSession(value: unknown): SessionState | null {
  if (!isRecord(value)) return null;
  const persisted = value as PersistedSession;
  if (persisted.version !== 1 && persisted.version !== CURRENT_SESSION_VERSION) return null;
  if (!Array.isArray(persisted.snapshots)) return null;

  return {
    ...(persisted as SessionState),
    version: CURRENT_SESSION_VERSION,
    rois: { ...DEFAULT_ROIS, ...(isRecord(persisted.rois) ? persisted.rois : {}) },
    medications: normalizeMedicationState(persisted.medications),
    snapshots: persisted.snapshots
      .filter(isRecord)
      .map((snapshot) => normalizeSnapshot(snapshot as PersistedSnapshot)),
  };
}

function failureResult(code: SaveSessionFailureCode, error?: unknown): SaveSessionResult {
  const errorName = isRecord(error) && typeof error.name === 'string' ? error.name : '';
  const message = isRecord(error) && typeof error.message === 'string'
    ? error.message
    : error == null
      ? ''
      : String(error);
  return {
    ok: false,
    key: SESSION_STORAGE_KEY,
    version: CURRENT_SESSION_VERSION,
    code,
    errorName,
    message,
  };
}

export function loadSession(): SessionState | null {
  const storage = getStorage();
  if (!storage) return null;

  for (const key of [SESSION_STORAGE_KEY, LEGACY_SESSION_STORAGE_KEY]) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      const session = normalizeSession(JSON.parse(raw));
      if (!session) continue;

      saveSession(session);
      return session;
    } catch {
      // Try the legacy key if the current entry is corrupt or unreadable.
    }
  }
  return null;
}

export function saveSession(state: SessionState): SaveSessionResult {
  const session = normalizeSession(state);
  if (!session) return failureResult('serialization-failed', new TypeError('Invalid session state'));

  let serialized: string;
  try {
    serialized = JSON.stringify(session);
  } catch (error) {
    return failureResult('serialization-failed', error);
  }

  const storage = getStorage();
  if (!storage) return failureResult('storage-unavailable');
  try {
    storage.setItem(SESSION_STORAGE_KEY, serialized);
  } catch (error) {
    const errorName = isRecord(error) && typeof error.name === 'string' ? error.name : '';
    const code = errorName === 'QuotaExceededError'
      ? 'quota-exceeded'
      : errorName === 'SecurityError' || errorName === 'NotSupportedError'
        ? 'storage-unavailable'
        : 'write-failed';
    return failureResult(code, error);
  }

  try {
    storage.removeItem(LEGACY_SESSION_STORAGE_KEY);
  } catch {
    // Saving succeeded; legacy cleanup must not turn it into a false failure.
  }
  return { ok: true, key: SESSION_STORAGE_KEY, version: CURRENT_SESSION_VERSION };
}

export function clearPersistedSession(): void {
  const storage = getStorage();
  if (!storage) return;
  for (const key of [SESSION_STORAGE_KEY, LEGACY_SESSION_STORAGE_KEY]) {
    try {
      storage.removeItem(key);
    } catch {
      // Continue so one blocked key does not prevent cleanup of the other.
    }
  }
}
