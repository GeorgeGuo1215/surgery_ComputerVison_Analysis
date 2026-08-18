export type VitalKey = 'hr' | 'spo2' | 'pr' | 'nibp' | 'rr' | 'etco2' | 'fico2' | 'temp';

export type ReadingStatus =
  | 'ok'
  | 'manual-corrected'
  | 'low-confidence'
  | 'out-of-range'
  | 'not-found'
  | 'not-configured';

export type CaptureMode = 'camera' | 'video' | 'demo' | 'idle';

export interface NormalizedROI {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VitalDefinition {
  key: VitalKey;
  label: string;
  shortLabel: string;
  unit: string;
  color: string;
  min: number;
  max: number;
  maxJump: number;
  precision: number;
  defaultROI: NormalizedROI;
  demoValue: number[];
}

export interface ParsedVital {
  display: string;
  values: number[];
}

export interface VitalReading {
  key: VitalKey;
  display: string | null;
  values: number[];
  rawText: string;
  confidence: number;
  status: ReadingStatus;
  capturedAt: string;
  reason?: string;
}

export type ReadingMap = Record<VitalKey, VitalReading>;

export interface CaseMetadata {
  caseId: string;
  patientName: string;
  species: string;
  weight: string;
  procedure: string;
  clinician: string;
}

export interface RecordSnapshot {
  id: string;
  scheduledAt: string;
  recordedAt: string;
  source: 'scheduled' | 'manual';
  inputSource?: Exclude<CaptureMode, 'idle'>;
  mediaTimeSeconds?: number;
  sourceFileName?: string;
  videoStartAt?: string;
  analyzedAt?: string;
  analysisRunId?: string;
  readings: ReadingMap;
  quality: 'complete' | 'review' | 'missing';
  verified: boolean;
  note: string;
  audit: AuditEntry[];
}

export interface AuditEntry {
  id: string;
  metric: VitalKey;
  oldValue: string | null;
  newValue: string;
  reason: string;
  changedAt: string;
}

export type MedicationPhase =
  | 'preoperative'
  | 'induction'
  | 'maintenance'
  | 'intraoperative-additional'
  | 'recovery'
  | 'postoperative'
  | 'other';

export interface MedicationCatalogEntry {
  id: string;
  name: string;
  createdAt: string;
}

export interface MedicationLineItem {
  id: string;
  catalogEntryId: string | null;
  name: string;
  /** Human-entered dose text. Never parsed or calculated by the app. */
  doseText: string;
  unit: string;
  route: string;
  note: string;
}

export interface MedicationEvent {
  id: string;
  phase: MedicationPhase;
  phaseDetail: string;
  administeredAt: string;
  medications: MedicationLineItem[];
  note: string;
  createdAt: string;
  updatedAt: string;
}

export type MedicationAuditAction =
  | 'catalog-added'
  | 'catalog-removed'
  | 'event-created'
  | 'event-updated'
  | 'event-deleted';

export interface MedicationAuditEntry {
  id: string;
  action: MedicationAuditAction;
  entityType: 'catalog' | 'event';
  entityId: string;
  changedAt: string;
  before: MedicationCatalogEntry | MedicationEvent | null;
  after: MedicationCatalogEntry | MedicationEvent | null;
}

export interface MedicationState {
  version: 1;
  catalog: MedicationCatalogEntry[];
  events: MedicationEvent[];
  audit: MedicationAuditEntry[];
}

export interface SessionState {
  version: 1 | 2;
  sessionId: string;
  startedAt: string | null;
  metadata: CaseMetadata;
  rois: Record<VitalKey, NormalizedROI | null>;
  snapshots: RecordSnapshot[];
  recordIntervalMinutes: number;
  /** Optional for source compatibility; persistence always migrates it to an empty or normalized state. */
  medications?: MedicationState;
}

export interface OCRResult {
  text: string;
  confidence: number;
}
