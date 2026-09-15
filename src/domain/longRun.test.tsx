import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordTable } from '../components/RecordTable';
import { createSnapshot } from './recording';
import { buildCSV } from './export';
import { DEFAULT_ROIS, emptyReadingMap, formatDemoReading } from './vitals';
import { saveSession, SESSION_STORAGE_KEY } from '../services/persistence';
import type { SessionState } from './types';

export function simulatedSession(days: number): SessionState {
  const start = Date.parse('2026-09-15T00:00:00Z');
  return {
    version: 2, sessionId: 'long-run-synthetic', startedAt: new Date(start).toISOString(),
    metadata: { caseId: 'PERF-SYNTHETIC', patientName: '', species: '', weight: '', procedure: '', clinician: '' },
    rois: DEFAULT_ROIS, recordIntervalMinutes: 5,
    snapshots: Array.from({ length: days * 288 + 1 }, (_, index) => {
      const timestamp = new Date(start + index * 300_000).toISOString();
      const readings = emptyReadingMap(timestamp);
      readings.hr = formatDemoReading('hr', [118], timestamp);
      return { ...createSnapshot(readings, 'scheduled', timestamp, timestamp, { inputSource: 'demo' }), id: `synthetic-${index}` };
    }),
  };
}

describe('long-running session capacity (synthetic, not a real-time camera soak)', () => {
  it.each([1, 7, 30])('measures %i days of five-minute records without losing export rows', (days) => {
    const session = simulatedSession(days);
    const beforeRender = performance.now();
    const markup = renderToStaticMarkup(<RecordTable snapshots={session.snapshots} onCorrect={() => undefined} onNoteChange={() => undefined} onToggleVerified={() => undefined} />);
    const renderMs = performance.now() - beforeRender;
    const beforeCSV = performance.now();
    const csv = buildCSV(session.metadata, session.snapshots);
    const csvMs = performance.now() - beforeCSV;
    localStorage.clear();
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const beforeSave = performance.now();
    const result = saveSession(session);
    const saveMs = performance.now() - beforeSave;
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    const attempted = write.mock.calls.find(([key]) => key === SESSION_STORAGE_KEY)?.[1] ?? '';
    write.mockRestore();
    console.info('LONG_RUN_CAPACITY', JSON.stringify({ days, rows: session.snapshots.length,
      renderMs: +renderMs.toFixed(2), htmlBytes: new TextEncoder().encode(markup).length,
      csvMs: +csvMs.toFixed(2), csvBytes: new TextEncoder().encode(csv).length,
      saveMs: +saveMs.toFixed(2), localStorageSaved: result.ok,
      serializedCodeUnits: (stored ?? attempted).length,
      conservativeUTF16Bytes: (stored ?? attempted).length * 2,
    }));
    expect(csv.split('\r\n')).toHaveLength(session.snapshots.length + 1);
    expect(new Set(session.snapshots.map((row) => row.scheduledAt)).size).toBe(session.snapshots.length);
    expect(markup).toContain('118');
    if (days <= 7) expect(result.ok).toBe(true);
    localStorage.clear();
  }, 20_000);
});
