import { describe, expect, it } from 'vitest';
import {
  ACTIVE_VITAL_DEFINITIONS,
  ACTIVE_VITAL_KEYS,
  DEFERRED_VITAL_KEYS,
  MINDRAY_IMEC8_REFERENCE_VIDEO_ROIS,
  MINDRAY_IMEC8_VIDEO_ROIS,
  VITAL_KEYS,
  emptyReadingMap,
  evaluateReading,
  isAcceptedHeartRateReading,
  parseVitalText,
  parseManualHeartRateInput,
  postprocessHeartRateText,
  valuesWithinCaptureRange,
} from './vitals';

describe('HR-only MVP scope', () => {
  it('keeps the complete schema available while exposing only HR as active', () => {
    expect(VITAL_KEYS).toEqual(['hr', 'spo2', 'pr', 'nibp', 'rr', 'etco2', 'fico2', 'temp']);
    expect(ACTIVE_VITAL_KEYS).toEqual(['hr']);
    expect(ACTIVE_VITAL_DEFINITIONS.map(({ key }) => key)).toEqual(['hr']);
    expect(DEFERRED_VITAL_KEYS).toEqual(['spo2', 'pr', 'nibp', 'rr', 'etco2', 'fico2', 'temp']);
  });
});

describe('monitor digit parsing', () => {
  it('corrects O/I/S only inside a numeric-looking token without corrupting labels or units', () => {
    expect(postprocessHeartRateText(' HR:\tI2O bpm\n')).toMatchObject({
      outcome: 'parsed',
      parsed: { display: '120', values: [120] },
      candidates: [120],
    });
    expect(postprocessHeartRateText('SENSOR OK')).toMatchObject({
      outcome: 'not-found',
      parsed: null,
      candidates: [],
    });
  });

  it.each([
    ['*** HR: [118] bpm ***', '118', 118],
    ['### 心率 = 90 bpm ###', '90', 90],
    ['HR I2O bpm', '120', 120],
    ['HR S8 bpm', '58', 58],
  ])('extracts one labelled HR token from noise: %s', (rawText, display, value) => {
    expect(parseVitalText('hr', rawText)).toEqual({ display, values: [value] });
  });

  it('does not manufacture an HR number from labels or a correction-only token without any real digit', () => {
    expect(parseVitalText('hr', 'SENSOR OK')).toBeNull();
    expect(parseVitalText('hr', 'SpO2 sensor connected')).toBeNull();
    expect(parseVitalText('hr', 'HR O bpm')).toBeNull();
  });

  it.each(['-1', '020', '46.7', '46/98', '1 18'])('rejects unsafe HR text shape instead of choosing a substring: %s', (rawText) => {
    expect(parseVitalText('hr', rawText)).toBeNull();
    const reading = evaluateReading('hr', rawText, 99, '2026-08-17T08:00:00.000Z');
    expect(reading).toMatchObject({ display: null, values: [], status: 'not-found' });
  });

  it.each(['118 90', 'HR 118 bpm PR 90', 'HR 118 bpm PR 118'])('rejects ambiguous multiple numeric candidates: %s', (rawText) => {
    expect(parseVitalText('hr', rawText)).toBeNull();
    const reading = evaluateReading('hr', rawText, 98, '2026-08-17T08:00:00.000Z');
    expect(reading).toMatchObject({ display: null, values: [], status: 'not-found' });
    expect(reading.reason).toMatch(/多个|歧义/);
  });

  it('treats 0 and 200 as inclusive HR capture boundaries', () => {
    expect(parseVitalText('hr', '0')).toEqual({ display: '0', values: [0] });
    expect(parseVitalText('hr', '200')).toEqual({ display: '200', values: [200] });
    expect(valuesWithinCaptureRange('hr', [0])).toBe(true);
    expect(valuesWithinCaptureRange('hr', [200])).toBe(true);
  });

  it.each(['201', '517'])('rejects HR %s above the device capture range without changing it', (rawText) => {
    const reading = evaluateReading('hr', rawText, 98, '2026-08-17T08:00:00.000Z');
    expect(reading).toMatchObject({
      display: rawText,
      values: [Number(rawText)],
      status: 'out-of-range',
    });
  });

  it('inserts a missing temperature decimal for three digits', () => {
    expect(parseVitalText('temp', '376')).toEqual({ display: '37.6', values: [37.6] });
  });

  it('parses NIBP with systolic, diastolic and MAP', () => {
    expect(parseVitalText('nibp', '112/68 (82)')).toEqual({
      display: '112/68 (82)',
      values: [112, 68, 82],
    });
  });

  it('rejects impossible capture values without treating them as clinical thresholds', () => {
    expect(valuesWithinCaptureRange('spo2', [108])).toBe(false);
    expect(valuesWithinCaptureRange('spo2', [98])).toBe(true);
  });
});

describe('strict manual HR input', () => {
  it.each([
    ['0', '0', 0],
    ['200', '200', 200],
    [' \t50\n', '50', 50],
  ])('accepts only a trimmed canonical integer inside 0–200: %s', (rawText, display, value) => {
    expect(parseManualHeartRateInput(rawText)).toEqual({ display, values: [value] });
  });

  it.each(['B250', 'abc150', '.50', '+50', 'O50', '201', '020'])('rejects unsafe manual HR input without extracting a substring: %s', (rawText) => {
    expect(parseManualHeartRateInput(rawText)).toBeNull();
  });

  it('accepts a structurally valid automatic reading but not a single-digit automatic reading', () => {
    const timestamp = '2026-08-17T08:00:00.000Z';
    expect(isAcceptedHeartRateReading(evaluateReading('hr', '118', 99, timestamp))).toBe(true);
    expect(isAcceptedHeartRateReading(evaluateReading('hr', '4', 99, timestamp))).toBe(false);
  });
});

describe('confidence and temporal guardrails', () => {
  const timestamp = '2026-08-17T08:00:00.000Z';

  it('does not silently accept low OCR confidence', () => {
    const reading = evaluateReading('hr', '118', 42, timestamp);
    expect(reading.status).toBe('low-confidence');
    expect(reading.display).toBe('118');
  });

  it.each(['0', '4', '9'])('keeps a high-confidence single digit %s for review instead of auto-accepting it', (rawText) => {
    const reading = evaluateReading('hr', rawText, 99, timestamp);
    expect(reading).toMatchObject({ display: rawText, values: [Number(rawText)], status: 'low-confidence' });
    expect(reading.reason).toMatch(/单字符|前导数字|裁切/);
  });

  it('keeps a character-corrected HR candidate pending even when OCR confidence is high', () => {
    const corrected = evaluateReading('hr', 'HR I2O bpm', 99, timestamp);
    const direct = evaluateReading('hr', '120', 99, timestamp);

    expect(corrected).toMatchObject({ display: '120', values: [120], status: 'low-confidence' });
    expect(corrected.reason).toMatch(/字符纠正|人工核对|多帧/);
    expect(direct).toMatchObject({ display: '120', values: [120], status: 'ok' });
  });

  it('marks an extreme jump for review instead of replacing it with an old value', () => {
    const history = [
      evaluateReading('hr', '60', 96, timestamp),
      evaluateReading('hr', '62', 96, timestamp),
      evaluateReading('hr', '61', 96, timestamp),
    ];
    const reading = evaluateReading('hr', '190', 96, timestamp, history);
    expect(reading.status).toBe('low-confidence');
    expect(reading.display).toBe('190');
    expect(reading.display).not.toBe('61');
  });

  it.each([
    ['517', 'out-of-range', '517'],
    ['118 90', 'not-found', null],
    ['---', 'not-found', null],
  ] as const)('never fills rejected current text %s from the previous accepted value', (rawText, status, display) => {
    const previous = evaluateReading('hr', '85', 96, timestamp);
    const reading = evaluateReading('hr', rawText, 96, timestamp, [previous]);
    expect(previous).toMatchObject({ display: '85', status: 'ok' });
    expect(reading).toMatchObject({ display, status });
    expect(reading.display).not.toBe(previous.display);
  });

  it('represents every unavailable metric as null, never zero', () => {
    const readings = emptyReadingMap(timestamp);
    expect(Object.values(readings).every((reading) => reading.display === null)).toBe(true);
    expect(DEFERRED_VITAL_KEYS.every((key) => (
      readings[key].status === 'not-configured'
      && readings[key].reason?.includes('后置')
    ))).toBe(true);
  });

  it('keeps every Mindray portrait-video ROI inside the source frame', () => {
    for (const profile of [MINDRAY_IMEC8_VIDEO_ROIS, MINDRAY_IMEC8_REFERENCE_VIDEO_ROIS]) {
      expect(Object.keys(profile).sort()).toEqual([...VITAL_KEYS].sort());
      for (const roi of Object.values(profile)) {
        expect(roi.x).toBeGreaterThanOrEqual(0);
        expect(roi.y).toBeGreaterThanOrEqual(0);
        expect(roi.x + roi.width).toBeLessThanOrEqual(1);
        expect(roi.y + roi.height).toBeLessThanOrEqual(1);
      }
    }
    expect(MINDRAY_IMEC8_VIDEO_ROIS.fico2.y).toBeGreaterThan(0.69);
    expect(MINDRAY_IMEC8_REFERENCE_VIDEO_ROIS.hr.y).toBeLessThan(MINDRAY_IMEC8_VIDEO_ROIS.hr.y);
  });
});
