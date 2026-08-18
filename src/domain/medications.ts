import type {
  CaseMetadata,
  MedicationAuditEntry,
  MedicationCatalogEntry,
  MedicationEvent,
  MedicationLineItem,
  MedicationPhase,
  MedicationState,
} from './types';

export const MEDICATION_PHASES: ReadonlyArray<{ value: MedicationPhase; label: string }> = [
  { value: 'preoperative', label: '术前' },
  { value: 'induction', label: '麻醉诱导' },
  { value: 'maintenance', label: '麻醉维持' },
  { value: 'intraoperative-additional', label: '术中追加' },
  { value: 'recovery', label: '复苏期' },
  { value: 'postoperative', label: '术后' },
  { value: 'other', label: '其他' },
] as const;

const MEDICATION_PHASE_VALUES = new Set<MedicationPhase>(MEDICATION_PHASES.map(({ value }) => value));

export interface MedicationLineInput {
  id?: string;
  catalogEntryId?: string | null;
  name: string;
  doseText: string;
  unit: string;
  route: string;
  note?: string;
}

export interface MedicationEventInput {
  phase: MedicationPhase;
  phaseDetail?: string;
  administeredAt: string;
  medications: MedicationLineInput[];
  note?: string;
}

export interface MedicationMutationOptions {
  changedAt?: string;
  makeId?: (prefix: 'medication-catalog' | 'medication-event' | 'medication-line' | 'medication-audit') => string;
}

let fallbackIdCounter = 0;

function defaultId(prefix: 'medication-catalog' | 'medication-event' | 'medication-line' | 'medication-audit'): string {
  const randomId = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${fallbackIdCounter += 1}`;
  return `${prefix}-${randomId}`;
}

function mutationContext(options: MedicationMutationOptions = {}) {
  const changedAt = options.changedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(changedAt))) throw new Error('变更时间无效。');
  return {
    changedAt,
    makeId: options.makeId ?? defaultId,
  };
}

function cleanText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function cloneCatalogEntry(entry: MedicationCatalogEntry): MedicationCatalogEntry {
  return { ...entry };
}

function cloneMedicationLine(line: MedicationLineItem): MedicationLineItem {
  return { ...line };
}

function cloneMedicationEvent(event: MedicationEvent): MedicationEvent {
  return {
    ...event,
    medications: event.medications.map(cloneMedicationLine),
  };
}

function auditEntry(
  action: MedicationAuditEntry['action'],
  entityType: MedicationAuditEntry['entityType'],
  entityId: string,
  before: MedicationAuditEntry['before'],
  after: MedicationAuditEntry['after'],
  options: ReturnType<typeof mutationContext>,
): MedicationAuditEntry {
  return {
    id: options.makeId('medication-audit'),
    action,
    entityType,
    entityId,
    changedAt: options.changedAt,
    before: before == null
      ? null
      : 'medications' in before
        ? cloneMedicationEvent(before)
        : cloneCatalogEntry(before),
    after: after == null
      ? null
      : 'medications' in after
        ? cloneMedicationEvent(after)
        : cloneCatalogEntry(after),
  };
}

export function createEmptyMedicationState(): MedicationState {
  return {
    version: 1,
    catalog: [],
    events: [],
    audit: [],
  };
}

export function medicationPhaseLabel(phase: MedicationPhase, phaseDetail = ''): string {
  if (phase === 'other' && cleanText(phaseDetail)) return cleanText(phaseDetail);
  return MEDICATION_PHASES.find(({ value }) => value === phase)?.label ?? '其他';
}

export function validateMedicationEventInput(input: MedicationEventInput): string[] {
  const errors: string[] = [];
  if (!MEDICATION_PHASE_VALUES.has(input.phase)) errors.push('请选择有效的给药阶段。');
  if (input.phase === 'other' && !cleanText(input.phaseDetail)) errors.push('请填写其他阶段名称。');
  if (!Number.isFinite(Date.parse(input.administeredAt))) errors.push('请填写有效的给药时间。');
  if (!Array.isArray(input.medications) || input.medications.length === 0) {
    errors.push('一个联合用药记录至少需要一种药物。');
    return errors;
  }

  input.medications.forEach((line, index) => {
    const position = `第 ${index + 1} 种药物`;
    if (!cleanText(line.name)) errors.push(`${position}缺少药物名称。`);
    if (!cleanText(line.doseText)) errors.push(`${position}缺少人工填写的剂量文本。`);
    if (!cleanText(line.unit)) errors.push(`${position}缺少单位。`);
    if (!cleanText(line.route)) errors.push(`${position}缺少给药途径。`);
  });
  return errors;
}

export function addMedicationCatalogEntry(
  state: MedicationState,
  name: string,
  options: MedicationMutationOptions = {},
): MedicationState {
  const normalizedName = cleanText(name);
  if (!normalizedName) throw new Error('药物名称不能为空。');
  if (state.catalog.some((entry) => entry.name.localeCompare(normalizedName, undefined, { sensitivity: 'accent' }) === 0)) {
    throw new Error('药物目录中已存在同名条目。');
  }
  const context = mutationContext(options);
  const entry: MedicationCatalogEntry = {
    id: context.makeId('medication-catalog'),
    name: normalizedName,
    createdAt: context.changedAt,
  };
  return {
    ...state,
    catalog: [...state.catalog, entry],
    audit: [...state.audit, auditEntry('catalog-added', 'catalog', entry.id, null, entry, context)],
  };
}

export function removeMedicationCatalogEntry(
  state: MedicationState,
  catalogEntryId: string,
  options: MedicationMutationOptions = {},
): MedicationState {
  const existing = state.catalog.find(({ id }) => id === catalogEntryId);
  if (!existing) throw new Error('未找到要移除的药物目录条目。');
  const context = mutationContext(options);
  return {
    ...state,
    catalog: state.catalog.filter(({ id }) => id !== catalogEntryId),
    audit: [...state.audit, auditEntry('catalog-removed', 'catalog', existing.id, existing, null, context)],
  };
}

function materializeMedicationEvent(
  input: MedicationEventInput,
  context: ReturnType<typeof mutationContext>,
  existing?: MedicationEvent,
): MedicationEvent {
  const errors = validateMedicationEventInput(input);
  if (errors.length > 0) throw new Error(errors.join(' '));
  const lines = input.medications.map((line): MedicationLineItem => ({
    id: cleanText(line.id) || context.makeId('medication-line'),
    catalogEntryId: cleanText(line.catalogEntryId ?? undefined) || null,
    name: cleanText(line.name),
    doseText: cleanText(line.doseText),
    unit: cleanText(line.unit),
    route: cleanText(line.route),
    note: cleanText(line.note),
  }));
  return {
    id: existing?.id ?? context.makeId('medication-event'),
    phase: input.phase,
    phaseDetail: input.phase === 'other' ? cleanText(input.phaseDetail) : '',
    administeredAt: new Date(input.administeredAt).toISOString(),
    medications: lines,
    note: cleanText(input.note),
    createdAt: existing?.createdAt ?? context.changedAt,
    updatedAt: context.changedAt,
  };
}

export function createMedicationEvent(
  state: MedicationState,
  input: MedicationEventInput,
  options: MedicationMutationOptions = {},
): MedicationState {
  const context = mutationContext(options);
  const event = materializeMedicationEvent(input, context);
  return {
    ...state,
    events: [...state.events, event].sort((left, right) => Date.parse(left.administeredAt) - Date.parse(right.administeredAt)),
    audit: [...state.audit, auditEntry('event-created', 'event', event.id, null, event, context)],
  };
}

export function updateMedicationEvent(
  state: MedicationState,
  eventId: string,
  input: MedicationEventInput,
  options: MedicationMutationOptions = {},
): MedicationState {
  const existing = state.events.find(({ id }) => id === eventId);
  if (!existing) throw new Error('未找到要编辑的联合用药记录。');
  const context = mutationContext(options);
  const event = materializeMedicationEvent(input, context, existing);
  return {
    ...state,
    events: state.events
      .map((candidate) => candidate.id === eventId ? event : candidate)
      .sort((left, right) => Date.parse(left.administeredAt) - Date.parse(right.administeredAt)),
    audit: [...state.audit, auditEntry('event-updated', 'event', event.id, existing, event, context)],
  };
}

export function deleteMedicationEvent(
  state: MedicationState,
  eventId: string,
  options: MedicationMutationOptions = {},
): MedicationState {
  const existing = state.events.find(({ id }) => id === eventId);
  if (!existing) throw new Error('未找到要删除的联合用药记录。');
  const context = mutationContext(options);
  return {
    ...state,
    events: state.events.filter(({ id }) => id !== eventId),
    audit: [...state.audit, auditEntry('event-deleted', 'event', existing.id, existing, null, context)],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeCatalogEntry(value: unknown): MedicationCatalogEntry | null {
  if (!isRecord(value)) return null;
  const id = cleanText(stringValue(value.id));
  const name = cleanText(stringValue(value.name));
  if (!id || !name) return null;
  const createdAt = Number.isFinite(Date.parse(stringValue(value.createdAt)))
    ? stringValue(value.createdAt)
    : new Date(0).toISOString();
  return { id, name, createdAt };
}

function normalizeMedicationLine(value: unknown): MedicationLineItem | null {
  if (!isRecord(value)) return null;
  const id = cleanText(stringValue(value.id));
  const name = cleanText(stringValue(value.name));
  if (!id || !name) return null;
  return {
    id,
    catalogEntryId: cleanText(stringValue(value.catalogEntryId)) || null,
    name,
    doseText: cleanText(stringValue(value.doseText)),
    unit: cleanText(stringValue(value.unit)),
    route: cleanText(stringValue(value.route)),
    note: cleanText(stringValue(value.note)),
  };
}

function normalizeMedicationEvent(value: unknown): MedicationEvent | null {
  if (!isRecord(value)) return null;
  const id = cleanText(stringValue(value.id));
  const phaseValue = stringValue(value.phase) as MedicationPhase;
  const administeredAt = stringValue(value.administeredAt);
  if (!id || !MEDICATION_PHASE_VALUES.has(phaseValue) || !Number.isFinite(Date.parse(administeredAt))) return null;
  const medications = Array.isArray(value.medications)
    ? value.medications.map(normalizeMedicationLine).filter((line): line is MedicationLineItem => line != null)
    : [];
  if (medications.length === 0) return null;
  const createdAt = Number.isFinite(Date.parse(stringValue(value.createdAt)))
    ? stringValue(value.createdAt)
    : administeredAt;
  const updatedAt = Number.isFinite(Date.parse(stringValue(value.updatedAt)))
    ? stringValue(value.updatedAt)
    : createdAt;
  return {
    id,
    phase: phaseValue,
    phaseDetail: cleanText(stringValue(value.phaseDetail)),
    administeredAt,
    medications,
    note: cleanText(stringValue(value.note)),
    createdAt,
    updatedAt,
  };
}

function normalizeAuditSnapshot(value: unknown): MedicationAuditEntry['before'] {
  return normalizeMedicationEvent(value) ?? normalizeCatalogEntry(value);
}

function normalizeMedicationAudit(value: unknown): MedicationAuditEntry | null {
  if (!isRecord(value)) return null;
  const actions = new Set<MedicationAuditEntry['action']>([
    'catalog-added',
    'catalog-removed',
    'event-created',
    'event-updated',
    'event-deleted',
  ]);
  const action = stringValue(value.action) as MedicationAuditEntry['action'];
  const entityType = stringValue(value.entityType);
  const id = cleanText(stringValue(value.id));
  const entityId = cleanText(stringValue(value.entityId));
  const changedAt = stringValue(value.changedAt);
  if (
    !id
    || !entityId
    || !actions.has(action)
    || (entityType !== 'catalog' && entityType !== 'event')
    || !Number.isFinite(Date.parse(changedAt))
  ) return null;
  return {
    id,
    action,
    entityType,
    entityId,
    changedAt,
    before: normalizeAuditSnapshot(value.before),
    after: normalizeAuditSnapshot(value.after),
  };
}

/** Best-effort migration for sessions created before medication recording existed. */
export function normalizeMedicationState(value: unknown): MedicationState {
  if (!isRecord(value)) return createEmptyMedicationState();
  const catalog = Array.isArray(value.catalog)
    ? value.catalog.map(normalizeCatalogEntry).filter((entry): entry is MedicationCatalogEntry => entry != null)
    : [];
  const events = Array.isArray(value.events)
    ? value.events.map(normalizeMedicationEvent).filter((event): event is MedicationEvent => event != null)
    : [];
  const audit = Array.isArray(value.audit)
    ? value.audit.map(normalizeMedicationAudit).filter((entry): entry is MedicationAuditEntry => entry != null)
    : [];
  return {
    version: 1,
    catalog,
    events: events.sort((left, right) => Date.parse(left.administeredAt) - Date.parse(right.administeredAt)),
    audit,
  };
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const caseHeaders = ['病例号', '动物姓名', '物种', '体重', '手术', '医生'];

function caseValues(metadata: CaseMetadata): string[] {
  return [
    metadata.caseId,
    metadata.patientName,
    metadata.species,
    metadata.weight,
    metadata.procedure,
    metadata.clinician,
  ];
}

export function buildMedicationCSV(metadata: CaseMetadata, state: MedicationState): string {
  const header = [
    '联合用药记录ID',
    '给药时间',
    '阶段',
    '阶段补充',
    '组合备注',
    '药物序号',
    '药物名称',
    '剂量文本',
    '单位',
    '途径',
    '药物备注',
    '创建时间',
    '更新时间',
    ...caseHeaders,
  ];
  const rows = state.events.flatMap((event) => event.medications.map((line, index) => [
    event.id,
    event.administeredAt,
    medicationPhaseLabel(event.phase, event.phaseDetail),
    event.phaseDetail,
    event.note,
    index + 1,
    line.name,
    line.doseText,
    line.unit,
    line.route,
    line.note,
    event.createdAt,
    event.updatedAt,
    ...caseValues(metadata),
  ]));
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function buildMedicationAuditCSV(state: MedicationState): string {
  const header = ['审计ID', '变更时间', '动作', '实体类型', '实体ID', '变更前JSON', '变更后JSON'];
  const rows = state.audit.map((entry) => [
    entry.id,
    entry.changedAt,
    entry.action,
    entry.entityType,
    entry.entityId,
    entry.before == null ? '' : JSON.stringify(entry.before),
    entry.after == null ? '' : JSON.stringify(entry.after),
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function buildMedicationJSON(
  metadata: CaseMetadata,
  state: MedicationState,
  exportedAt = new Date().toISOString(),
): string {
  return JSON.stringify({
    schemaVersion: 'petor-monitor/medications/1.0',
    exportedAt,
    purpose: '人工联合用药记录与审计导出',
    safety: {
      humanEnteredOnly: true,
      doseCalculatedByApplication: false,
      clinicalRecommendation: false,
      warning: '药物名称、剂量文本、单位、途径和备注均由人员填写；系统不提供剂量建议或计算。',
    },
    caseMetadata: { ...metadata },
    medicationState: normalizeMedicationState(state),
  }, null, 2);
}
