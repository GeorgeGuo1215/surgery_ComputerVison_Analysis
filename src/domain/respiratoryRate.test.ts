import { describe, expect, it } from 'vitest';
import { emptyReadingMap, evaluateReading, formatDemoReading, isAcceptedVitalReading, parseManualRespiratoryRateInput, parseVitalText } from './vitals';
import { consensusReading } from './offline';
import { createSnapshot } from './recording';
import { buildCSV, projectSessionForExport } from './export';
import { snapshotSpeech } from '../services/speech';
import { loadSession, saveSession } from '../services/persistence';
import { DEFAULT_ROIS } from './vitals';
import type { SessionState } from './types';

const timestamp = '2026-09-15T02:05:00.125Z';

describe('respiratory rate acquisition', () => {
  it.each(['0', '4', '18', '180', 'RR: 18 /min', 'RESP 18', '呼吸率 １８ 次每分钟'])(
    'accepts a single direct RR integer without the HR single-digit restriction: %s', (rawText) => {
      const reading = evaluateReading('rr', rawText, 99, timestamp);
      expect(isAcceptedVitalReading(reading)).toBe(true);
      expect(reading.capturedAt).toBe(timestamp);
    },
  );

  it.each(['---', '', '-18', '+18', '18.5', '18 20', '018', '1O', 'SENSOR OK', 'HR 118', 'RR 18 HR 118', 'RR 18 SpO2 98'])(
    'does not manufacture RR from ambiguous or malformed OCR: %s', (rawText) => {
      expect(parseVitalText('rr', rawText)).toBeNull();
      expect(evaluateReading('rr', rawText, 99, timestamp).status).toBe('not-found');
    },
  );

  it('keeps above-range and low-confidence candidates out of accepted values', () => {
    expect(evaluateReading('rr', '181', 99, timestamp).status).toBe('out-of-range');
    const low = evaluateReading('rr', '18', 64, timestamp);
    expect(low.status).toBe('low-confidence');
    expect(isAcceptedVitalReading(low)).toBe(false);
    expect(isAcceptedVitalReading({ ...low, status: 'ok', display: '18', values: [18.5] })).toBe(false);
    expect(isAcceptedVitalReading({ ...low, status: 'ok', display: '18', values: [18, 19] })).toBe(false);
  });

  it('requires plain integers for manual corrections', () => {
    for (const text of ['0', '4', '18', '180', '１８']) expect(parseManualRespiratoryRateInput(text)).not.toBeNull();
    for (const text of ['RR 18', '18 /min', '181', '-1', '1.5', '018', '1O', '']) expect(parseManualRespiratoryRateInput(text)).toBeNull();
  });

  it('requires strict multi-frame majority and refuses a possible clipped digit', () => {
    const candidates = (texts: string[]) => texts.map((text) => evaluateReading('rr', text, 99, timestamp));
    expect(consensusReading('rr', candidates(['4', '4', '4']), timestamp)).toMatchObject({ display: '4', status: 'ok' });
    expect(consensusReading('rr', candidates(['0', '0', '---']), timestamp)).toMatchObject({ display: '0', status: 'ok' });
    expect(consensusReading('rr', candidates(['18', '18', '19']), timestamp)).toMatchObject({ display: '18', status: 'ok' });
    expect(consensusReading('rr', candidates(['18', '18', '8']), timestamp)).toMatchObject({ display: null, status: 'low-confidence' });
    expect(consensusReading('rr', candidates(['18', '---', '---']), timestamp).status).toBe('low-confidence');
  });

  it('exports missing RR as empty, retaining its own timestamp and HR value', () => {
    const readings = emptyReadingMap(timestamp);
    readings.hr = formatDemoReading('hr', [118], timestamp);
    readings.rr = evaluateReading('rr', '---', 99, timestamp);
    const snapshot = createSnapshot(readings, 'scheduled', timestamp, timestamp);
    const metadata = { caseId: 'RR-QA', patientName: '', species: '', weight: '', procedure: '', clinician: '' };
    const [header, row] = buildCSV(metadata, [snapshot]).slice(1).split('\r\n').map((line) => line.split(','));
    expect(row[header.indexOf('HR')]).toBe('118');
    expect(row[header.indexOf('RR')]).toBe('');
    expect(row[header.indexOf('RR采集时间ISO_UTC')]).toBe(timestamp);
    expect(snapshot.quality).toBe('review');
    expect(snapshotSpeech(readings)).not.toContain('呼吸率');
  });

  it('preserves RR data and correction audit through storage and JSON export', () => {
    localStorage.clear();
    const session: SessionState = { version: 2, sessionId: 'rr-test', startedAt: timestamp, recordIntervalMinutes: 5,
      metadata: { caseId: '', patientName: '', species: '', weight: '', procedure: '', clinician: '' },
      rois: DEFAULT_ROIS, snapshots: [createSnapshot(emptyReadingMap(timestamp), 'scheduled', timestamp, timestamp)] };
    const reading = { ...formatDemoReading('rr', [0], timestamp), status: 'manual-corrected' as const };
    session.snapshots[0].readings.rr = reading;
    session.snapshots[0].audit = [{ id: 'rr-audit', metric: 'rr', oldValue: null, newValue: '0', changedAt: timestamp, reason: '核对原画面' }];
    expect(saveSession(session).ok).toBe(true);
    const restored = loadSession()!;
    expect(restored.snapshots[0].readings.rr).toEqual(reading);
    const exported = projectSessionForExport(restored);
    expect(exported.snapshots[0].readings.rr.acceptedDisplay).toBe('0');
    expect(exported.snapshots[0].audit[0].metric).toBe('rr');
    session.snapshots[0].readings.rr = { ...reading, display: '999', values: [999] };
    saveSession(session);
    expect(loadSession()!.snapshots[0].readings.rr.status).toBe('low-confidence');
    localStorage.clear();
  });
});
