import type { ReadingStatus, RecordSnapshot } from './types';
import {
  HEART_RATE_CAPTURE_RANGE,
  isAcceptedHeartRateReading,
  valuesWithinCaptureRange,
} from './vitals';

export interface HeartRateReferenceSample {
  rowNumber: number;
  timestamp: string | null;
  videoTimeSeconds: number;
  rawValue: number | null;
  referenceValue: number | null;
  provenance:
    | 'direct-raw-match'
    | 'filtered-or-derived'
    | 'provided-ground-truth'
    | 'provided-unverified'
    | 'invalid'
    | 'missing';
}

export interface HeartRateReferenceDataset {
  fileName: string;
  fileSizeBytes: number | null;
  fileLastModified: number | null;
  importedAt: string;
  sourceColumn: string;
  sourceKind: 'filtered' | 'ground-truth' | 'reference' | 'raw' | 'generic';
  samples: HeartRateReferenceSample[];
  cadenceSeconds: number | null;
  firstVideoTimeSeconds: number;
  lastVideoTimeSeconds: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  primaryEligibleCount: number;
  directReferenceCount: number;
  derivedReferenceCount: number;
  missingReferenceCount: number;
  warnings: string[];
}

export type HeartRateComparisonResult =
  | 'exact'
  | 'within-2'
  | 'mismatch'
  | 'needs-review'
  | 'ocr-rejected'
  | 'manual-excluded'
  | 'derived-reference-excluded'
  | 'invalid-reference'
  | 'no-reference';

export interface HeartRateComparisonRow {
  snapshotId: string;
  videoTimeSeconds: number;
  scheduledAt: string;
  ocrValue: number | null;
  ocrDisplay: string | null;
  ocrStatus: ReadingStatus;
  ocrConfidence: number;
  referenceTimeSeconds: number | null;
  referenceTimestamp: string | null;
  referenceRawValue: number | null;
  referenceValue: number | null;
  referenceRowNumber: number | null;
  referenceProvenance: HeartRateReferenceSample['provenance'] | null;
  alignmentDeltaSeconds: number | null;
  differenceBpm: number | null;
  absoluteErrorBpm: number | null;
  includedInPrimaryMetrics: boolean;
  result: HeartRateComparisonResult;
}

export interface HeartRateComparisonSummary {
  snapshotCount: number;
  alignedCount: number;
  eligibleReferenceCount: number;
  derivedReferenceExcludedCount: number;
  invalidReferenceCount: number;
  acceptedCount: number;
  reviewCount: number;
  rejectedCount: number;
  manualExcludedCount: number;
  exactAcceptedCount: number;
  withinTwoAcceptedCount: number;
  withinFiveAcceptedCount: number;
  exactCoveragePercent: number | null;
  withinTwoCoveragePercent: number | null;
  withinFiveCoveragePercent: number | null;
  acceptedExactRatePercent: number | null;
  meanAbsoluteErrorBpm: number | null;
  rootMeanSquareErrorBpm: number | null;
  meanBiasBpm: number | null;
  maximumAbsoluteErrorBpm: number | null;
}

export interface HeartRateComparisonReport {
  sourceVideoName: string;
  referenceFileName: string;
  referenceColumn: string;
  alignmentOffsetSeconds: number;
  alignmentToleranceSeconds: number;
  rows: HeartRateComparisonRow[];
  summary: HeartRateComparisonSummary;
}

const TIME_ALIASES = ['video_time_s', 'media_time_s', 'video_time', 'time_s', 'seconds', 'relative_seconds'];
const TIMESTAMP_ALIASES = ['timestamp', 'datetime', 'date_time', 'recorded_at', 'captured_at'];
const RAW_ALIASES = ['raw_value', 'raw_hr', 'ocr_raw_value'];
const REFERENCE_COLUMNS: Array<{
  aliases: string[];
  kind: HeartRateReferenceDataset['sourceKind'];
}> = [
  { aliases: ['ground_truth', 'ground_truth_hr', 'label', 'label_hr', 'manual_value'], kind: 'ground-truth' },
  { aliases: ['reference_value', 'reference_hr', 'truth_value'], kind: 'reference' },
  { aliases: ['filtered_value', 'filtered_hr'], kind: 'filtered' },
  { aliases: ['heart_rate', 'hr', 'value'], kind: 'generic' },
  { aliases: RAW_ALIASES, kind: 'raw' },
];

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function parseDelimitedRows(text: string): string[][] {
  const headerLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const delimiters = [',', '\t', ';'];
  const delimiter = delimiters
    .map((candidate) => ({ candidate, count: headerLine.split(candidate).length - 1 }))
    .sort((left, right) => right.count - left.count)[0]?.candidate ?? ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function findColumn(headers: string[], aliases: string[]): number {
  return aliases.map((alias) => headers.indexOf(alias)).find((index) => index >= 0) ?? -1;
}

function parseNumber(value: string | undefined): number | null {
  const normalized = value?.trim() ?? '';
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function parseHeartRateReferenceCSV(
  text: string,
  fileName: string,
  fileMetadata: { sizeBytes?: number; lastModified?: number; importedAt?: string } = {},
): HeartRateReferenceDataset {
  if (!text.trim()) throw new Error('参考 CSV 为空。');
  const rows = parseDelimitedRows(text);
  if (rows.length < 2) throw new Error('参考 CSV 没有数据行。');
  const originalHeaders = rows[0].map((header) => header.replace(/^\uFEFF/, '').trim());
  const headers = originalHeaders.map(normalizeHeader);
  const timeIndex = findColumn(headers, TIME_ALIASES);
  if (timeIndex < 0) throw new Error(`缺少视频相对时间列；支持：${TIME_ALIASES.join('、')}。`);

  const referenceSelection = REFERENCE_COLUMNS
    .map(({ aliases, kind }) => ({ index: findColumn(headers, aliases), kind }))
    .find(({ index }) => index >= 0);
  if (!referenceSelection) throw new Error('缺少 HR 参考值列；支持 filtered_value、ground_truth、reference_value、heart_rate 或 hr。');

  const timestampIndex = findColumn(headers, TIMESTAMP_ALIASES);
  const rawIndex = findColumn(headers, RAW_ALIASES);
  const samples = rows.slice(1).flatMap((row, rowIndex) => {
    const videoTimeSeconds = parseNumber(row[timeIndex]);
    if (videoTimeSeconds == null || videoTimeSeconds < 0) return [];
    const rawValue = rawIndex >= 0 ? parseNumber(row[rawIndex]) : null;
    const referenceValue = parseNumber(row[referenceSelection.index]);
    let provenance: HeartRateReferenceSample['provenance'];
    if (referenceValue == null) provenance = 'missing';
    else if (!valuesWithinCaptureRange('hr', [referenceValue])) provenance = 'invalid';
    else if (referenceSelection.kind === 'filtered') {
      provenance = rawValue != null && rawValue === referenceValue
        ? 'direct-raw-match'
        : 'filtered-or-derived';
    } else if (referenceSelection.kind === 'ground-truth') provenance = 'provided-ground-truth';
    else provenance = 'provided-unverified';
    return [{
      rowNumber: rowIndex + 2,
      timestamp: timestampIndex >= 0 ? row[timestampIndex]?.trim() || null : null,
      videoTimeSeconds,
      rawValue,
      referenceValue,
      provenance,
    } satisfies HeartRateReferenceSample];
  }).sort((left, right) => left.videoTimeSeconds - right.videoTimeSeconds || left.rowNumber - right.rowNumber);

  if (samples.length === 0) throw new Error('参考 CSV 中没有有效的非负视频时间。');
  if (!samples.some(({ referenceValue }) => referenceValue != null)) throw new Error('参考值列中没有可用数字。');

  const timeCounts = new Map<number, number>();
  for (const sample of samples) timeCounts.set(sample.videoTimeSeconds, (timeCounts.get(sample.videoTimeSeconds) ?? 0) + 1);
  const duplicateTimes = [...timeCounts.values()].filter((count) => count > 1).length;
  const positiveDeltas = samples.slice(1)
    .map((sample, index) => sample.videoTimeSeconds - samples[index].videoTimeSeconds)
    .filter((delta) => delta > 0);
  const cadenceSeconds = median(positiveDeltas);
  const warnings: string[] = [];
  if (referenceSelection.kind === 'filtered') {
    warnings.push('当前参考列是 filtered_value（已有算法的滤波结果），不是人工逐帧标注或监护仪原始数据。');
  } else if (referenceSelection.kind === 'raw' || referenceSelection.kind === 'generic') {
    warnings.push('CSV 未明确标注为人工真值；该列仅作为工程参考结果。');
  }
  if (samples.length < rows.length - 1) warnings.push(`${rows.length - 1 - samples.length} 行因视频时间无效而未导入。`);
  if (samples.some(({ referenceValue }) => referenceValue == null)) warnings.push('部分参考值为空，对应时间点不会计入主指标分母。');
  if (samples.some(({ provenance }) => provenance === 'invalid')) {
    warnings.push(`部分参考值不是 ${HEART_RATE_CAPTURE_RANGE.min}–${HEART_RATE_CAPTURE_RANGE.max} bpm 的整数，已排除出主指标。`);
  }
  if (duplicateTimes > 0) warnings.push(`发现 ${duplicateTimes} 个重复视频时间；对齐时使用时间最近且行号靠前的样本。`);

  return {
    fileName,
    fileSizeBytes: Number.isFinite(fileMetadata.sizeBytes) ? fileMetadata.sizeBytes ?? null : null,
    fileLastModified: Number.isFinite(fileMetadata.lastModified) ? fileMetadata.lastModified ?? null : null,
    importedAt: fileMetadata.importedAt ?? new Date().toISOString(),
    sourceColumn: originalHeaders[referenceSelection.index] || headers[referenceSelection.index],
    sourceKind: referenceSelection.kind,
    samples,
    cadenceSeconds,
    firstVideoTimeSeconds: samples[0].videoTimeSeconds,
    lastVideoTimeSeconds: samples[samples.length - 1].videoTimeSeconds,
    firstTimestamp: samples.find(({ timestamp }) => timestamp)?.timestamp ?? null,
    lastTimestamp: [...samples].reverse().find(({ timestamp }) => timestamp)?.timestamp ?? null,
    primaryEligibleCount: samples.filter(({ provenance }) => (
      provenance === 'direct-raw-match'
      || provenance === 'provided-ground-truth'
      || provenance === 'provided-unverified'
    )).length,
    directReferenceCount: samples.filter(({ provenance }) => provenance === 'direct-raw-match').length,
    derivedReferenceCount: samples.filter(({ provenance }) => provenance === 'filtered-or-derived').length,
    missingReferenceCount: samples.filter(({ provenance }) => provenance === 'missing').length,
    warnings,
  };
}

function nearestReferenceSample(
  samples: HeartRateReferenceSample[],
  targetSeconds: number,
): HeartRateReferenceSample | null {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].videoTimeSeconds < targetSeconds) low = middle + 1;
    else high = middle;
  }
  const candidates = [samples[low - 1], samples[low]].filter(Boolean) as HeartRateReferenceSample[];
  return candidates.sort((left, right) => (
    Math.abs(left.videoTimeSeconds - targetSeconds) - Math.abs(right.videoTimeSeconds - targetSeconds)
    || left.rowNumber - right.rowNumber
  ))[0] ?? null;
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator * 100 : null;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function defaultAlignmentTolerance(dataset: HeartRateReferenceDataset): number {
  return dataset.cadenceSeconds == null
    ? 0.5
    : Math.min(5, Math.max(0.05, dataset.cadenceSeconds / 2));
}

function isEligibleReference(sample: HeartRateReferenceSample): boolean {
  return sample.provenance === 'direct-raw-match'
    || sample.provenance === 'provided-ground-truth'
    || sample.provenance === 'provided-unverified';
}

export function compareHeartRateSnapshots(
  snapshots: RecordSnapshot[],
  dataset: HeartRateReferenceDataset,
  sourceVideoName: string,
  alignmentOffsetSeconds = 0,
  alignmentToleranceSeconds = defaultAlignmentTolerance(dataset),
): HeartRateComparisonReport {
  const relevantSnapshots = snapshots
    .filter((snapshot) => (
      snapshot.inputSource === 'video'
      && snapshot.sourceFileName === sourceVideoName
      && snapshot.mediaTimeSeconds != null
    ))
    .sort((left, right) => (left.mediaTimeSeconds ?? 0) - (right.mediaTimeSeconds ?? 0));

  const rows = relevantSnapshots.map((snapshot): HeartRateComparisonRow => {
    const videoTimeSeconds = snapshot.mediaTimeSeconds ?? 0;
    const targetReferenceTime = videoTimeSeconds + alignmentOffsetSeconds;
    const nearest = nearestReferenceSample(dataset.samples, targetReferenceTime);
    const alignmentDeltaSeconds = nearest == null ? null : nearest.videoTimeSeconds - targetReferenceTime;
    const aligned = nearest != null && Math.abs(alignmentDeltaSeconds ?? Number.POSITIVE_INFINITY) <= alignmentToleranceSeconds;
    const referenceValue = aligned ? nearest.referenceValue : null;
    const referenceProvenance = aligned ? nearest.provenance : null;
    const eligibleReference = aligned && isEligibleReference(nearest);
    const reading = snapshot.readings.hr;
    const acceptedHeartRate = isAcceptedHeartRateReading(reading);
    const ocrValue = reading.values[0] ?? (reading.display == null ? null : parseNumber(reading.display));
    const differenceBpm = ocrValue != null && referenceValue != null ? ocrValue - referenceValue : null;
    const absoluteErrorBpm = differenceBpm == null ? null : Math.abs(differenceBpm);
    let result: HeartRateComparisonResult;
    if (!aligned || referenceValue == null || referenceProvenance === 'missing') result = 'no-reference';
    else if (referenceProvenance === 'invalid') result = 'invalid-reference';
    else if (referenceProvenance === 'filtered-or-derived') result = 'derived-reference-excluded';
    else if (reading.status === 'manual-corrected' && acceptedHeartRate) result = 'manual-excluded';
    else if (ocrValue == null || reading.status === 'not-found' || reading.status === 'not-configured') result = 'ocr-rejected';
    else if (!acceptedHeartRate || reading.status !== 'ok') result = 'needs-review';
    else if (absoluteErrorBpm === 0) result = 'exact';
    else if (absoluteErrorBpm != null && absoluteErrorBpm <= 2) result = 'within-2';
    else result = 'mismatch';

    return {
      snapshotId: snapshot.id,
      videoTimeSeconds,
      scheduledAt: snapshot.scheduledAt,
      ocrValue,
      ocrDisplay: reading.display,
      ocrStatus: reading.status,
      ocrConfidence: reading.confidence,
      referenceTimeSeconds: aligned ? nearest.videoTimeSeconds : null,
      referenceTimestamp: aligned ? nearest.timestamp : null,
      referenceRawValue: aligned ? nearest.rawValue : null,
      referenceValue,
      referenceRowNumber: aligned ? nearest.rowNumber : null,
      referenceProvenance,
      alignmentDeltaSeconds: aligned ? alignmentDeltaSeconds : null,
      differenceBpm,
      absoluteErrorBpm,
      includedInPrimaryMetrics: eligibleReference && reading.status === 'ok' && acceptedHeartRate && ocrValue != null,
      result,
    };
  });

  const alignedRows = rows.filter(({ referenceTimeSeconds }) => referenceTimeSeconds != null);
  const eligibleRows = alignedRows.filter(({ referenceProvenance }) => (
    referenceProvenance === 'direct-raw-match'
    || referenceProvenance === 'provided-ground-truth'
    || referenceProvenance === 'provided-unverified'
  ));
  const acceptedRows = eligibleRows.filter(({ includedInPrimaryMetrics }) => includedInPrimaryMetrics);
  const absoluteErrors = acceptedRows.flatMap(({ absoluteErrorBpm }) => absoluteErrorBpm == null ? [] : [absoluteErrorBpm]);
  const signedErrors = acceptedRows.flatMap(({ differenceBpm }) => differenceBpm == null ? [] : [differenceBpm]);
  const squaredErrors = signedErrors.map((difference) => difference ** 2);
  const exactAcceptedCount = acceptedRows.filter(({ absoluteErrorBpm }) => absoluteErrorBpm === 0).length;
  const withinTwoAcceptedCount = acceptedRows.filter(({ absoluteErrorBpm }) => absoluteErrorBpm != null && absoluteErrorBpm <= 2).length;
  const withinFiveAcceptedCount = acceptedRows.filter(({ absoluteErrorBpm }) => absoluteErrorBpm != null && absoluteErrorBpm <= 5).length;
  const meanSquaredError = average(squaredErrors);
  const summary: HeartRateComparisonSummary = {
    snapshotCount: rows.length,
    alignedCount: alignedRows.length,
    eligibleReferenceCount: eligibleRows.length,
    derivedReferenceExcludedCount: alignedRows.filter(({ referenceProvenance }) => referenceProvenance === 'filtered-or-derived').length,
    invalidReferenceCount: alignedRows.filter(({ referenceProvenance }) => referenceProvenance === 'invalid').length,
    acceptedCount: acceptedRows.length,
    reviewCount: eligibleRows.filter(({ result }) => result === 'needs-review').length,
    rejectedCount: eligibleRows.filter(({ result }) => result === 'ocr-rejected').length,
    manualExcludedCount: eligibleRows.filter(({ result }) => result === 'manual-excluded').length,
    exactAcceptedCount,
    withinTwoAcceptedCount,
    withinFiveAcceptedCount,
    exactCoveragePercent: percentage(exactAcceptedCount, eligibleRows.length),
    withinTwoCoveragePercent: percentage(withinTwoAcceptedCount, eligibleRows.length),
    withinFiveCoveragePercent: percentage(withinFiveAcceptedCount, eligibleRows.length),
    acceptedExactRatePercent: percentage(exactAcceptedCount, acceptedRows.length),
    meanAbsoluteErrorBpm: average(absoluteErrors),
    rootMeanSquareErrorBpm: meanSquaredError == null ? null : Math.sqrt(meanSquaredError),
    meanBiasBpm: average(signedErrors),
    maximumAbsoluteErrorBpm: absoluteErrors.length > 0 ? Math.max(...absoluteErrors) : null,
  };

  return {
    sourceVideoName,
    referenceFileName: dataset.fileName,
    referenceColumn: dataset.sourceColumn,
    alignmentOffsetSeconds,
    alignmentToleranceSeconds,
    rows,
    summary,
  };
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildHeartRateComparisonCSV(report: HeartRateComparisonReport): string {
  const header = [
    '源视频',
    '参考文件',
    '参考列',
    'CSV时间修正(秒)',
    '最大对齐容差(秒)',
    '视频时间(秒)',
    '计划时间',
    'OCR HR(bpm)',
    'OCR状态',
    'OCR置信度',
    '参考时间(秒)',
    '参考时间戳',
    '参考原始值',
    `参考HR(bpm) [${report.referenceColumn}]`,
    '参考行号',
    '参考来源质量',
    '对齐误差(秒)',
    '差值(bpm)',
    '绝对误差(bpm)',
    '纳入主指标',
    '对比结果',
  ];
  const rows = report.rows.map((row) => [
    report.sourceVideoName,
    report.referenceFileName,
    report.referenceColumn,
    report.alignmentOffsetSeconds,
    report.alignmentToleranceSeconds,
    row.videoTimeSeconds,
    row.scheduledAt,
    row.ocrValue,
    row.ocrStatus,
    Math.round(row.ocrConfidence),
    row.referenceTimeSeconds,
    row.referenceTimestamp,
    row.referenceRawValue,
    row.referenceValue,
    row.referenceRowNumber,
    row.referenceProvenance,
    row.alignmentDeltaSeconds,
    row.differenceBpm,
    row.absoluteErrorBpm,
    row.includedInPrimaryMetrics ? '是' : '否',
    row.result,
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function buildHeartRateComparisonJSON(
  report: HeartRateComparisonReport,
  dataset: HeartRateReferenceDataset,
  sourceVideo: object | null,
  exportedAt = new Date().toISOString(),
): string {
  return JSON.stringify({
    schemaVersion: 'petor-monitor/hr-reference-comparison/1.0',
    exportedAt,
    notice: '与参考 CSV 的工程一致性对比；不是临床准确率、人工真值或监护仪原始数据认证。',
    sourceVideo: sourceVideo == null ? null : { ...sourceVideo, localPathStored: false },
    referenceSource: {
      fileName: dataset.fileName,
      fileSizeBytes: dataset.fileSizeBytes,
      fileLastModified: dataset.fileLastModified,
      importedAt: dataset.importedAt,
      sourceColumn: dataset.sourceColumn,
      sourceKind: dataset.sourceKind,
      sampleCount: dataset.samples.length,
      cadenceSeconds: dataset.cadenceSeconds,
      firstVideoTimeSeconds: dataset.firstVideoTimeSeconds,
      lastVideoTimeSeconds: dataset.lastVideoTimeSeconds,
      primaryEligibleCount: dataset.primaryEligibleCount,
      directReferenceCount: dataset.directReferenceCount,
      derivedReferenceCount: dataset.derivedReferenceCount,
      missingReferenceCount: dataset.missingReferenceCount,
      warnings: dataset.warnings,
      localPathStored: false,
    },
    comparison: report,
  }, null, 2);
}
