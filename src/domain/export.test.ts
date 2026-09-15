import { describe, expect, it, vi } from 'vitest';
import { buildCSV, projectSessionForExport, safeFilenamePart, saveOrShareText } from './export';
import { createSnapshot } from './recording';
import { DEFAULT_ROIS, emptyReadingMap, evaluateReading, formatDemoReading } from './vitals';
import type { CaseMetadata, SessionState } from './types';

describe('audit-friendly export', () => {
  const metadata: CaseMetadata = {
    caseId: 'OR-001',
    patientName: '豆豆',
    species: '犬',
    weight: '6.2 kg',
    procedure: '绝育术',
    clinician: '张医生',
  };

  it('uses a UTF-8 BOM and preserves missing values as empty cells', () => {
    const readings = emptyReadingMap('2026-08-17T08:00:00.000Z');
    readings.hr = formatDemoReading('hr', [118], '2026-08-17T08:00:00.000Z');
    const csv = buildCSV(metadata, [createSnapshot(readings, 'scheduled', '2026-08-17T08:00:02.000Z', '2026-08-17T08:00:00.000Z')]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('118,,99,ok');
    expect(csv).toContain('延迟秒数');
    expect(csv).toContain(',2,自动,');
  });

  it('exports only the active HR columns and does not expose deferred metrics', () => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const readings = emptyReadingMap(capturedAt);
    readings.hr = formatDemoReading('hr', [118], capturedAt);
    readings.spo2 = formatDemoReading('spo2', [98], capturedAt);
    readings.pr = formatDemoReading('pr', [117], capturedAt);
    const csv = buildCSV(metadata, [createSnapshot(readings, 'scheduled', capturedAt, capturedAt)]);
    const [header, row] = csv.slice(1).split('\r\n');

    expect(header).toContain('HR,HR候选值,HR置信度,HR状态,HR原始文字');
    expect(header).not.toMatch(/SpO₂|PR|NIBP|RR|EtCO₂|FiCO₂|TEMP/);
    expect(row).toContain('118,,99,ok,118');
    expect(row).not.toContain('98,99,ok,98');
    expect(row).not.toContain('117,99,ok,117');
    expect(row.split(',')).toHaveLength(header.split(',').length);
  });

  it.each([
    ['single-digit pending review', '4', 99, 'low-confidence', '4'],
    ['above-range rejection', '517', 99, 'out-of-range', '517'],
  ] as const)('keeps non-ok HR out of the reliable column and exports it only as a candidate: %s', (
    _label,
    rawText,
    confidence,
    expectedStatus,
    expectedCandidate,
  ) => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const readings = emptyReadingMap(capturedAt);
    readings.hr = evaluateReading('hr', rawText, confidence, capturedAt);
    const csv = buildCSV(metadata, [createSnapshot(readings, 'scheduled', capturedAt, capturedAt)]);
    const [header, row] = csv.slice(1).split('\r\n');
    const headers = header.split(',');
    const cells = row.split(',');

    expect(cells[headers.indexOf('HR')]).toBe('');
    expect(cells[headers.indexOf('HR候选值')]).toBe(expectedCandidate);
    expect(cells[headers.indexOf('HR状态')]).toBe(expectedStatus);
  });

  it('sanitizes exported filenames', () => {
    expect(safeFilenamePart(' OR/001: 豆豆 ')).toBe('OR_001_豆豆');
  });

  it('keeps acquisition, alignment and analysis timestamps distinct with millisecond precision', () => {
    const capturedAt = '2026-09-15T02:04:59.125Z';
    const scheduledAt = '2026-09-15T02:05:00.000Z';
    const analyzedAt = '2026-09-15T02:05:01.500Z';
    const snapshot = createSnapshot(emptyReadingMap(capturedAt), 'scheduled', analyzedAt, scheduledAt);
    const [header, row] = buildCSV(metadata, [snapshot]).slice(1).split('\r\n').map((line) => line.split(','));
    expect(row[header.indexOf('对齐时间ISO_UTC')]).toBe(scheduledAt);
    expect(row[header.indexOf('对齐时间戳ms')]).toBe(String(Date.parse(scheduledAt)));
    expect(row[header.indexOf('HR采集时间ISO_UTC')]).toBe(capturedAt);
    expect(row[header.indexOf('写入分析时间ISO_UTC')]).toBe(analyzedAt);
    expect(row[header.indexOf('记录ID')]).toBe(snapshot.id);
  });

  it.each([undefined, '2026-09-15T02:00:00.000Z'])('exports absolute video alignment only with a known origin: %s', (videoStartAt) => {
    const scheduledAt = '2026-09-15T02:05:00.000Z';
    const snapshot = createSnapshot(emptyReadingMap(scheduledAt), 'scheduled', '2026-09-16T03:00:00Z', scheduledAt, {
      inputSource: 'video', mediaTimeSeconds: 300, videoStartAt,
    });
    const [header, row] = buildCSV(metadata, [snapshot]).slice(1).split('\r\n').map((line) => line.split(','));
    expect(row[header.indexOf('视频时间')]).toBe('300');
    expect(row[header.indexOf('对齐时间ISO_UTC')]).toBe(videoStartAt ? scheduledAt : '');
    expect(row[header.indexOf('对齐时间戳ms')]).toBe(videoStartAt ? String(Date.parse(scheduledAt)) : '');
    expect(row[header.indexOf('HR采集时间ISO_UTC')]).toBe(videoStartAt ? scheduledAt : '');
  });

  it('exports offline media time, keeps a missing HR cell empty and omits inactive PR', () => {
    const capturedAt = '2026-08-17T08:05:00.000Z';
    const readings = emptyReadingMap(capturedAt);
    readings.hr = {
      ...readings.hr,
      status: 'not-found',
      reason: '监护仪显示横线',
    };
    readings.pr = formatDemoReading('pr', [86], capturedAt);
    const analyzedAt = '2026-08-17T09:00:00.000Z';
    const snapshot = createSnapshot(readings, 'scheduled', analyzedAt, capturedAt, {
      inputSource: 'video',
      mediaTimeSeconds: 300,
      sourceFileName: 'fixture.mp4',
      analyzedAt,
      analysisRunId: 'fixture-run',
    });

    const [, row] = buildCSV(metadata, [snapshot]).split('\r\n');
    expect(row.startsWith(',300,')).toBe(true);
    expect(row).toContain(',自动,视频导入,fixture.mp4,');
    expect(row).toContain(',not-found,');
    expect(row).not.toContain('86,99,ok,86');
  });

  it('projects JSON audit export to HR while preserving explicit deferred scope', () => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const readings = emptyReadingMap(capturedAt);
    readings.hr = formatDemoReading('hr', [118], capturedAt);
    readings.spo2 = formatDemoReading('spo2', [98], capturedAt);
    const snapshot = createSnapshot(readings, 'scheduled', capturedAt, capturedAt);
    snapshot.audit = [
      { id: 'audit-hr', metric: 'hr', oldValue: '117', newValue: '118', reason: '核对 HR', changedAt: capturedAt },
      { id: 'audit-spo2', metric: 'spo2', oldValue: '97', newValue: '98', reason: '旧数据', changedAt: capturedAt },
    ];
    const session: SessionState = {
      version: 2,
      sessionId: 'hr-only-export',
      startedAt: capturedAt,
      metadata,
      rois: structuredClone(DEFAULT_ROIS),
      snapshots: [snapshot],
      recordIntervalMinutes: 5,
    };

    const projected = projectSessionForExport(session);

    expect(projected.productScope).toEqual({
      activeVitalKeys: ['hr'],
      deferredVitalKeys: ['spo2', 'pr', 'nibp', 'rr', 'etco2', 'fico2', 'temp'],
    });
    expect(Object.keys(projected.rois)).toEqual(['hr']);
    expect(Object.keys(projected.snapshots[0].readings)).toEqual(['hr']);
    expect(projected.snapshots[0].audit.map(({ metric }) => metric)).toEqual(['hr']);
    expect(Object.keys(session.snapshots[0].readings)).toHaveLength(8);
    expect(session.snapshots[0].audit).toHaveLength(2);
  });

  it('uses the operating-system file share sheet on supported mobile browsers', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });

    await expect(saveOrShareText('内容', '记录.csv', 'text/csv', true)).resolves.toBe('shared');
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ files: [expect.any(File)] }));
  });
});
