import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadingMap, SessionState } from '../domain/types';
import { buildCSV } from '../domain/export';
import {
  DEFAULT_ROIS,
  emptyReadingMap,
  formatDemoReading,
  isAcceptedHeartRateReading,
} from '../domain/vitals';
import {
  LEGACY_SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  clearPersistedSession,
  loadSession,
  saveSession,
} from './persistence';

const timestamp = '2026-08-17T08:00:00.000Z';

function makeSession(version: 1 | 2 = 1): SessionState {
  const readings = emptyReadingMap(timestamp);
  readings.hr = formatDemoReading('hr', [118], timestamp);
  return {
    version,
    sessionId: 'migration-test',
    startedAt: timestamp,
    metadata: {
      caseId: 'QA-01',
      patientName: '演示犬',
      species: '犬',
      weight: '8 kg',
      procedure: '验收',
      clinician: 'QA',
    },
    rois: { ...DEFAULT_ROIS },
    snapshots: [{
      id: 'snapshot-1',
      scheduledAt: timestamp,
      recordedAt: timestamp,
      source: 'scheduled',
      readings,
      quality: 'review',
      verified: false,
      note: '',
      audit: [],
    }],
    recordIntervalMinutes: 5,
  };
}

describe('session persistence migration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('writes new sessions under the v2 key with a v2 payload', () => {
    const result = saveSession(makeSession(1));

    expect(result).toEqual({ ok: true, key: SESSION_STORAGE_KEY, version: 2 });
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!)).toMatchObject({
      version: 2,
      sessionId: 'migration-test',
    });
    expect(localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('compacts only empty inactive readings and restores their original timestamps losslessly', () => {
    const session = makeSession(2);
    session.snapshots[0].quality = 'complete';
    session.snapshots[0].readings.spo2.capturedAt = '2026-08-17T07:59:59.123Z';
    session.snapshots[0].readings.pr = formatDemoReading('pr', [117], timestamp);
    session.snapshots[0].readings.pr.reason = '历史识别值';
    session.snapshots[0].readings.rr.reason = '历史拒识说明';
    expect(saveSession(session).ok).toBe(true);
    const stored = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!);
    expect(stored.snapshots[0].readings.spo2).toEqual({ capturedAt: '2026-08-17T07:59:59.123Z' });
    expect(JSON.parse(JSON.stringify(loadSession()!.snapshots))).toEqual(JSON.parse(JSON.stringify(session.snapshots)));
    expect(loadSession()!.snapshots[0].readings.pr.display).toBe('117');
    expect(loadSession()!.snapshots[0].readings.rr.reason).toBe('历史拒识说明');
  });

  it('loads legacy v1 data, keeps deferred PR not-configured and grades quality from HR', () => {
    const legacy = makeSession(1);
    const legacyReadings = { ...legacy.snapshots[0].readings } as Partial<ReadingMap>;
    delete legacyReadings.pr;
    legacy.snapshots[0].readings = legacyReadings as ReadingMap;
    delete (legacy.rois as Partial<typeof legacy.rois>).pr;
    localStorage.setItem(LEGACY_SESSION_STORAGE_KEY, JSON.stringify(legacy));

    const restored = loadSession();

    expect(restored?.version).toBe(2);
    expect(restored?.snapshots[0].readings.hr.display).toBe('118');
    expect(restored?.snapshots[0].readings.pr).toMatchObject({
      key: 'pr',
      display: null,
      values: [],
      rawText: '',
      confidence: 0,
      status: 'not-configured',
      capturedAt: timestamp,
    });
    expect(restored?.snapshots[0].quality).toBe('complete');
    expect(restored?.rois.pr).toEqual(DEFAULT_ROIS.pr);
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!)).toMatchObject({ version: 2 });
    expect(localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('falls back to a valid legacy entry when the v2 entry is corrupt', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, '{not-json');
    localStorage.setItem(LEGACY_SESSION_STORAGE_KEY, JSON.stringify(makeSession(1)));

    expect(loadSession()?.sessionId).toBe('migration-test');
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!)).toMatchObject({ version: 2 });
  });

  it.each([
    ['out-of-range ok value', '250', [250]],
    ['single-character automatic ok value', '4', [4]],
    ['display/value mismatch', '150', [105]],
  ])('downgrades unsafe persisted v2 HR instead of restoring it as accepted: %s', (_label, display, values) => {
    const persisted = makeSession(2);
    persisted.snapshots[0].readings.hr = {
      ...persisted.snapshots[0].readings.hr,
      display,
      values,
      rawText: display,
      confidence: 99,
      status: 'ok',
    };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(persisted));

    const restored = loadSession();
    expect(restored).not.toBeNull();
    const restoredSnapshot = restored!.snapshots[0];
    const restoredHeartRate = restoredSnapshot.readings.hr;
    expect(isAcceptedHeartRateReading(restoredHeartRate)).toBe(false);
    expect(restoredHeartRate.status).not.toBe('ok');
    expect(restoredHeartRate.status).not.toBe('manual-corrected');
    expect(restoredSnapshot.quality).not.toBe('complete');

    const [header, row] = buildCSV(restored!.metadata, [restoredSnapshot]).slice(1).split('\r\n');
    const headers = header.split(',');
    const cells = row.split(',');
    expect(cells[headers.indexOf('HR')]).toBe('');
  });

  it('returns an observable quota failure without claiming the session was saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota reached', 'QuotaExceededError');
    });

    expect(saveSession(makeSession())).toMatchObject({
      ok: false,
      key: SESSION_STORAGE_KEY,
      version: 2,
      code: 'quota-exceeded',
      errorName: 'QuotaExceededError',
      message: 'Storage quota reached',
    });
  });

  it('reports blocked browser storage as unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError');
    });

    expect(saveSession(makeSession())).toMatchObject({
      ok: false,
      code: 'storage-unavailable',
      errorName: 'SecurityError',
      message: 'Storage access denied',
    });
  });

  it('clears current and legacy keys', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(makeSession(2)));
    localStorage.setItem(LEGACY_SESSION_STORAGE_KEY, JSON.stringify(makeSession(1)));

    clearPersistedSession();

    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_SESSION_STORAGE_KEY)).toBeNull();
  });
});
