import { describe, expect, it } from 'vitest';
import { createSnapshot } from './recording';
import {
  buildHeartRateComparisonCSV,
  buildHeartRateComparisonJSON,
  compareHeartRateSnapshots,
  parseHeartRateReferenceCSV,
} from './referenceComparison';
import type { ReadingStatus } from './types';
import { emptyReadingMap } from './vitals';
import referencePairFixture from '../../docs/fixtures/mindray-imec8-vet-reference-pair.json';

const REFERENCE_CSV = '\uFEFFtimestamp,video_time_s,raw_value,filtered_value\r\n'
  + '2026-08-01 14:23:09.733,0.0,46,46\r\n'
  + '2026-08-01 14:23:10.733,1.0,,46\r\n'
  + '2026-08-01 14:23:11.733,2.0,4,47\r\n';

const GROUND_TRUTH_CSV = 'video_time_s,ground_truth\n0,46\n1,46\n2,47\n';

function snapshot(time: number, value: number | null, status: ReadingStatus = 'ok') {
  const capturedAt = new Date(Date.UTC(2026, 7, 1, 6, 23, 9) + time * 1000).toISOString();
  const readings = emptyReadingMap(capturedAt);
  readings.hr = {
    ...readings.hr,
    display: value == null ? null : String(value),
    values: value == null ? [] : [value],
    confidence: value == null ? 0 : 91,
    status,
  };
  return createSnapshot(readings, 'scheduled', capturedAt, capturedAt, {
    inputSource: 'video',
    mediaTimeSeconds: time,
    sourceFileName: '1.mp4',
  });
}

describe('heart-rate reference comparison', () => {
  it('keeps the supplied reference-pair audit metadata explicit and non-clinical', () => {
    expect(referencePairFixture.video.durationSeconds).toBeCloseTo(602.333333);
    expect(referencePairFixture.referenceCsv.rowCount).toBe(603);
    expect(referencePairFixture.referenceCsv.directRawEqualsFilteredCount).toBe(481);
    expect(referencePairFixture.referenceCsv.filteredOrDerivedCount).toBe(122);
    expect(referencePairFixture.manualFrameChecks.at(-1)).toMatchObject({
      screenHrBpm: 47,
      csvRawValue: 4,
      csvFilteredValue: 50,
      classification: 'derived-reference-excluded',
    });
    expect(referencePairFixture.clinicalUse).toBe(false);
  });

  it('parses the supplied CSV shape without treating filtered output as clinical truth', () => {
    const dataset = parseHeartRateReferenceCSV(REFERENCE_CSV, '8.8_143312_hr_data_full.csv');
    expect(dataset.samples).toHaveLength(3);
    expect(dataset.cadenceSeconds).toBe(1);
    expect(dataset.sourceColumn).toBe('filtered_value');
    expect(dataset.sourceKind).toBe('filtered');
    expect(dataset.warnings.join(' ')).toContain('不是人工逐帧标注');
    expect(dataset.samples[1].rawValue).toBeNull();
    expect(dataset.samples[1].referenceValue).toBe(46);
    expect(dataset.directReferenceCount).toBe(1);
    expect(dataset.derivedReferenceCount).toBe(2);
  });

  it('uses the same inclusive 0–200 HR range for reference CSV eligibility', () => {
    const dataset = parseHeartRateReferenceCSV(
      'video_time_s,ground_truth\n0,0\n1,200\n2,201\n3,517\n4,-1\n5,46.7',
      'range-boundaries.csv',
    );

    expect(dataset.samples.map(({ referenceValue, provenance }) => ({ referenceValue, provenance }))).toEqual([
      { referenceValue: 0, provenance: 'provided-ground-truth' },
      { referenceValue: 200, provenance: 'provided-ground-truth' },
      { referenceValue: 201, provenance: 'invalid' },
      { referenceValue: 517, provenance: 'invalid' },
      { referenceValue: -1, provenance: 'invalid' },
      { referenceValue: 46.7, provenance: 'invalid' },
    ]);
    expect(dataset.primaryEligibleCount).toBe(2);
    expect(dataset.warnings.join(' ')).toContain('0–200 bpm');
  });

  it('aligns by video seconds and reports coverage, rejection and error separately', () => {
    const dataset = parseHeartRateReferenceCSV(GROUND_TRUTH_CSV, 'reference.csv');
    const report = compareHeartRateSnapshots([
      snapshot(0, 46),
      snapshot(1, null, 'not-found'),
      snapshot(2, 49),
    ], dataset, '1.mp4');

    expect(report.rows.map(({ result }) => result)).toEqual(['exact', 'ocr-rejected', 'within-2']);
    expect(report.summary.alignedCount).toBe(3);
    expect(report.summary.eligibleReferenceCount).toBe(3);
    expect(report.summary.derivedReferenceExcludedCount).toBe(0);
    expect(report.summary.acceptedCount).toBe(2);
    expect(report.summary.exactCoveragePercent).toBeCloseTo(100 / 3);
    expect(report.summary.withinTwoCoveragePercent).toBeCloseTo(200 / 3);
    expect(report.summary.meanAbsoluteErrorBpm).toBe(1);
    expect(report.summary.rootMeanSquareErrorBpm).toBeCloseTo(Math.sqrt(2));
  });

  it('aligns every integer-second result to all 603 reference rows without skipping or reusing a time', () => {
    const referenceRows = Array.from({ length: 603 }, (_, time) => {
      const heartRate = 40 + time % 80;
      return `${time},${heartRate}`;
    });
    const dataset = parseHeartRateReferenceCSV(
      `video_time_s,ground_truth\n${referenceRows.join('\n')}\n`,
      '603-point-ground-truth.csv',
    );
    const snapshots = Array.from({ length: 603 }, (_, time) => snapshot(time, 40 + time % 80));
    const report = compareHeartRateSnapshots(snapshots, dataset, '1.mp4');
    const referenceTimes = report.rows.map(({ referenceTimeSeconds }) => referenceTimeSeconds);

    expect(dataset.samples).toHaveLength(603);
    expect(report.rows).toHaveLength(603);
    expect(report.rows[0]).toMatchObject({
      videoTimeSeconds: 0,
      referenceTimeSeconds: 0,
      alignmentDeltaSeconds: 0,
      result: 'exact',
    });
    expect(report.rows.at(-1)).toMatchObject({
      videoTimeSeconds: 602,
      referenceTimeSeconds: 602,
      alignmentDeltaSeconds: 0,
      result: 'exact',
    });
    expect(referenceTimes).toEqual(Array.from({ length: 603 }, (_, index) => index));
    expect(new Set(referenceTimes).size).toBe(603);
    expect(report.summary).toMatchObject({
      snapshotCount: 603,
      alignedCount: 603,
      eligibleReferenceCount: 603,
      acceptedCount: 603,
      exactAcceptedCount: 603,
      exactCoveragePercent: 100,
      meanAbsoluteErrorBpm: 0,
      rootMeanSquareErrorBpm: 0,
      meanBiasBpm: 0,
      maximumAbsoluteErrorBpm: 0,
    });
  });

  it('excludes manual corrections from algorithm accuracy and supports an alignment offset', () => {
    const dataset = parseHeartRateReferenceCSV(GROUND_TRUTH_CSV, 'reference.csv');
    const report = compareHeartRateSnapshots([
      snapshot(0, 46, 'manual-corrected'),
      snapshot(1, 47),
    ], dataset, '1.mp4', 1);
    expect(report.rows[0].referenceTimeSeconds).toBe(1);
    expect(report.rows[0].result).toBe('manual-excluded');
    expect(report.rows[1].referenceTimeSeconds).toBe(2);
    expect(report.summary.manualExcludedCount).toBe(1);
    expect(report.summary.exactAcceptedCount).toBe(1);
  });

  it('does not search past a nearest blank reference or carry another value forward', () => {
    const dataset = parseHeartRateReferenceCSV(
      'video_time_s,reference_value\n0,45\n1,\n2,47',
      'sparse.csv',
    );
    const report = compareHeartRateSnapshots([snapshot(1, 45)], dataset, '1.mp4');
    expect(report.rows[0].referenceTimeSeconds).toBe(1);
    expect(report.rows[0].referenceValue).toBeNull();
    expect(report.rows[0].result).toBe('no-reference');
    expect(report.summary.eligibleReferenceCount).toBe(0);
  });

  it('does not align a reference point outside the configured tolerance', () => {
    const dataset = parseHeartRateReferenceCSV('video_time_s,ground_truth\n0,45', 'short.csv');
    const report = compareHeartRateSnapshots([snapshot(0.51, 45)], dataset, '1.mp4', 0, 0.5);
    expect(report.rows[0].referenceTimeSeconds).toBeNull();
    expect(report.rows[0].result).toBe('no-reference');
    expect(report.summary.alignedCount).toBe(0);
  });

  it('exports an auditable UTF-8 CSV with explicit source and missing cells', () => {
    const dataset = parseHeartRateReferenceCSV(REFERENCE_CSV, 'reference.csv');
    const report = compareHeartRateSnapshots([snapshot(1, null, 'not-found')], dataset, '1.mp4');
    const csv = buildHeartRateComparisonCSV(report);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('参考HR(bpm) [filtered_value]');
    expect(csv).toContain(',not-found,0,');
    expect(csv).toContain('filtered-or-derived');
  });

  it('exports JSON with the warning and source summary without embedding all reference samples', () => {
    const dataset = parseHeartRateReferenceCSV(REFERENCE_CSV, 'reference.csv', {
      sizeBytes: 123,
      lastModified: 456,
      importedAt: '2026-08-18T00:00:00.000Z',
    });
    const report = compareHeartRateSnapshots([snapshot(0, 46)], dataset, '1.mp4');
    const json = buildHeartRateComparisonJSON(
      report,
      dataset,
      { name: '1.mp4', sizeBytes: 999 },
      '2026-08-18T01:00:00.000Z',
    );
    const payload = JSON.parse(json) as Record<string, unknown>;
    expect(payload.notice).toContain('不是临床准确率');
    expect(json).toContain('"sampleCount": 3');
    expect(json).not.toContain('"samples"');
    expect(json).not.toContain('/Users/');
  });

  it('rejects a CSV that lacks a relative video time column', () => {
    expect(() => parseHeartRateReferenceCSV('timestamp,filtered_value\n2026-08-01,46', 'bad.csv'))
      .toThrow('缺少视频相对时间列');
  });
});
