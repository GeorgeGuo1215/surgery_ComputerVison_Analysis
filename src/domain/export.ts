import type { CaseMetadata, RecordSnapshot, SessionState, VitalKey } from './types';
import { normalizeMedicationState } from './medications';
import {
  ACTIVE_VITAL_DEFINITIONS,
  ACTIVE_VITAL_KEYS,
  DEFERRED_VITAL_KEYS,
  isAcceptedVitalReading,
} from './vitals';

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function localTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function buildCSV(metadata: CaseMetadata, snapshots: RecordSnapshot[]): string {
  const identityColumns = ['病例号', '动物姓名', '物种', '体重', '手术', '医生'];
  const readingColumns = ACTIVE_VITAL_DEFINITIONS.flatMap(({ shortLabel }) => [
    shortLabel,
    `${shortLabel}候选值`,
    `${shortLabel}置信度`,
    `${shortLabel}状态`,
    `${shortLabel}原始文字`,
  ]);
  const header = [
    '计划时间',
    '视频时间',
    '实际写入/分析时间',
    '延迟秒数',
    '记录方式',
    '输入源',
    '源文件',
    ...identityColumns,
    ...readingColumns,
    '数据质量',
    '人工已核对',
    '备注',
    '记录ID',
    '对齐时间ISO_UTC',
    '对齐时间戳ms',
    ...ACTIVE_VITAL_DEFINITIONS.map(({ shortLabel }) => `${shortLabel}采集时间ISO_UTC`),
    '写入分析时间ISO_UTC',
    '视频起始时间ISO_UTC',
  ];

  const metadataValues = [
    metadata.caseId,
    metadata.patientName,
    metadata.species,
    metadata.weight,
    metadata.procedure,
    metadata.clinician,
  ];

  const rows = snapshots.map((snapshot) => {
    const readings = ACTIVE_VITAL_DEFINITIONS.flatMap(({ key }) => {
      const reading = snapshot.readings[key as VitalKey];
      const reliable = isAcceptedVitalReading(reading);
      return [
        reliable ? reading.display ?? '' : '',
        reliable ? '' : reading.display ?? '',
        Math.round(reading.confidence),
        reading.status,
        reading.rawText,
      ];
    });
    const isOfflineVideo = snapshot.inputSource === 'video';
    const inputSource = snapshot.inputSource === 'video'
      ? '视频导入'
      : snapshot.inputSource === 'demo'
        ? '演示数据'
        : '摄像头';
    return [
      isOfflineVideo && !snapshot.videoStartAt ? '' : localTimestamp(snapshot.scheduledAt),
      snapshot.mediaTimeSeconds == null ? '' : snapshot.mediaTimeSeconds,
      localTimestamp(snapshot.analyzedAt ?? snapshot.recordedAt),
      isOfflineVideo ? '' : Math.max(0, Math.round((Date.parse(snapshot.recordedAt) - Date.parse(snapshot.scheduledAt)) / 1000)),
      snapshot.source === 'scheduled' ? '自动' : '手动',
      inputSource,
      snapshot.sourceFileName ?? '',
      ...metadataValues,
      ...readings,
      snapshot.quality,
      snapshot.verified ? '是' : '否',
      snapshot.note,
      snapshot.id,
      isOfflineVideo && !snapshot.videoStartAt ? '' : snapshot.scheduledAt,
      isOfflineVideo && !snapshot.videoStartAt ? '' : Date.parse(snapshot.scheduledAt),
      ...ACTIVE_VITAL_KEYS.map((key) => isOfflineVideo && !snapshot.videoStartAt ? '' : snapshot.readings[key].capturedAt),
      snapshot.analyzedAt ?? snapshot.recordedAt,
      snapshot.videoStartAt ?? '',
    ];
  });

  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function projectSessionForExport(session: SessionState) {
  return {
    ...session,
    productScope: {
      activeVitalKeys: [...ACTIVE_VITAL_KEYS],
      deferredVitalKeys: [...DEFERRED_VITAL_KEYS],
    },
    medications: normalizeMedicationState(session.medications),
    rois: Object.fromEntries(ACTIVE_VITAL_KEYS.map((key) => [key, session.rois[key]])),
    snapshots: session.snapshots.map((snapshot) => ({
      ...snapshot,
      readings: Object.fromEntries(ACTIVE_VITAL_KEYS.map((key) => {
        const reading = snapshot.readings[key];
        const reliable = isAcceptedVitalReading(reading);
        return [key, {
          ...reading,
          acceptedDisplay: reliable ? reading.display : null,
          candidateDisplay: reliable ? null : reading.display,
        }];
      })),
      audit: snapshot.audit.filter(({ metric }) => ACTIVE_VITAL_KEYS.includes(metric)),
    })),
  };
}

export {
  buildMedicationAuditCSV,
  buildMedicationCSV,
  buildMedicationJSON,
} from './medications';

export function downloadText(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function saveOrShareText(
  content: string,
  filename: string,
  mimeType: string,
  preferShare = false,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const navigatorWithFileShare = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
  };
  const file = new File([content], filename, { type: mimeType });
  if (
    preferShare &&
    typeof navigator.share === 'function' &&
    typeof navigatorWithFileShare.canShare === 'function' &&
    navigatorWithFileShare.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
    }
  }
  downloadText(content, filename, mimeType);
  return 'downloaded';
}

export function safeFilenamePart(value: string): string {
  return value.trim().replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^_+|_+$/g, '') || '未命名病例';
}
