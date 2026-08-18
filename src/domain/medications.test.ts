import { describe, expect, it } from 'vitest';
import {
  addMedicationCatalogEntry,
  buildMedicationAuditCSV,
  buildMedicationCSV,
  buildMedicationJSON,
  createEmptyMedicationState,
  createMedicationEvent,
  deleteMedicationEvent,
  normalizeMedicationState,
  removeMedicationCatalogEntry,
  updateMedicationEvent,
  validateMedicationEventInput,
} from './medications';
import type { CaseMetadata } from './types';

function deterministicOptions(changedAt = '2026-08-18T02:00:00.000Z') {
  let count = 0;
  return {
    changedAt,
    makeId: (prefix: 'medication-catalog' | 'medication-event' | 'medication-line' | 'medication-audit') => `${prefix}-${count += 1}`,
  };
}

const metadata: CaseMetadata = {
  caseId: 'CASE-MED-01',
  patientName: '测试动物',
  species: '犬',
  weight: '仅病例记录',
  procedure: '测试流程',
  clinician: '测试人员',
};

const combinationInput = {
  phase: 'induction' as const,
  administeredAt: '2026-08-18T03:15:00.000Z',
  medications: [
    {
      name: '医院自定义药物甲',
      doseText: '人工填写剂量甲',
      unit: '自定义单位甲',
      route: '人工填写途径甲',
      note: '逐项核对甲',
    },
    {
      name: '医院自定义药物乙',
      doseText: '人工填写剂量乙',
      unit: '自定义单位乙',
      route: '人工填写途径乙',
      note: '',
    },
  ],
  note: '同一时间的联合记录',
};

describe('medication event domain', () => {
  it('starts with no catalog, medication, dose, route, or recommendation defaults', () => {
    expect(createEmptyMedicationState()).toEqual({ version: 1, catalog: [], events: [], audit: [] });
  });

  it('supports a hospital-defined catalog without altering existing event names when catalog entries are removed', () => {
    const options = deterministicOptions();
    let state = addMedicationCatalogEntry(createEmptyMedicationState(), '  医院自定义药物甲  ', options);
    expect(state.catalog[0].name).toBe('医院自定义药物甲');
    expect(state.audit[0]).toMatchObject({ action: 'catalog-added', entityType: 'catalog' });
    expect(() => addMedicationCatalogEntry(state, '医院自定义药物甲', options)).toThrow('已存在');

    const catalogEntryId = state.catalog[0].id;
    state = createMedicationEvent(state, {
      ...combinationInput,
      medications: [{ ...combinationInput.medications[0], catalogEntryId }],
    }, options);
    state = removeMedicationCatalogEntry(state, catalogEntryId, options);

    expect(state.catalog).toHaveLength(0);
    expect(state.events[0].medications[0].name).toBe('医院自定义药物甲');
    expect(state.audit.at(-1)).toMatchObject({ action: 'catalog-removed', entityId: catalogEntryId });
  });

  it('records multiple medicines in one combination and keeps every dose field verbatim', () => {
    const state = createMedicationEvent(createEmptyMedicationState(), combinationInput, deterministicOptions());
    const event = state.events[0];

    expect(event.medications).toHaveLength(2);
    expect(event.medications.map(({ doseText }) => doseText)).toEqual(['人工填写剂量甲', '人工填写剂量乙']);
    expect(event.medications.map(({ unit }) => unit)).toEqual(['自定义单位甲', '自定义单位乙']);
    expect(state.audit[0]).toMatchObject({ action: 'event-created', entityId: event.id, before: null });
  });

  it('requires human-entered dose text, unit, route, phase, and time without calculating replacements', () => {
    const errors = validateMedicationEventInput({
      phase: 'maintenance',
      administeredAt: '',
      medications: [{ name: '药物甲', doseText: '', unit: '', route: '' }],
    });
    expect(errors.join(' ')).toMatch(/给药时间/);
    expect(errors.join(' ')).toMatch(/剂量文本/);
    expect(errors.join(' ')).toMatch(/单位/);
    expect(errors.join(' ')).toMatch(/途径/);
    expect(() => createMedicationEvent(createEmptyMedicationState(), {
      phase: 'maintenance',
      administeredAt: '',
      medications: [{ name: '药物甲', doseText: '', unit: '', route: '' }],
    }, deterministicOptions())).toThrow();
  });

  it('edits and deletes an event while retaining immutable before/after audit snapshots', () => {
    let state = createMedicationEvent(createEmptyMedicationState(), combinationInput, deterministicOptions());
    const eventId = state.events[0].id;
    state = updateMedicationEvent(state, eventId, {
      ...combinationInput,
      phase: 'maintenance',
      medications: combinationInput.medications.map((line, index) => ({
        ...line,
        id: state.events[0].medications[index].id,
        doseText: `${line.doseText}（复核后）`,
      })),
    }, deterministicOptions('2026-08-18T03:20:00.000Z'));

    expect(state.events[0].phase).toBe('maintenance');
    expect(state.audit.at(-1)).toMatchObject({
      action: 'event-updated',
      before: { phase: 'induction' },
      after: { phase: 'maintenance' },
    });
    expect((state.audit[0].after as { phase: string }).phase).toBe('induction');

    state = deleteMedicationEvent(state, eventId, deterministicOptions('2026-08-18T03:30:00.000Z'));
    expect(state.events).toHaveLength(0);
    expect(state.audit.at(-1)).toMatchObject({ action: 'event-deleted', after: null });
    expect((state.audit.at(-1)?.before as { medications: unknown[] }).medications).toHaveLength(2);
  });
});

describe('medication migration and export', () => {
  it('migrates missing or malformed legacy medication state safely', () => {
    expect(normalizeMedicationState(undefined)).toEqual(createEmptyMedicationState());
    expect(normalizeMedicationState({ catalog: [{ id: '', name: '无效' }], events: [{}], audit: [{}] }))
      .toEqual(createEmptyMedicationState());
  });

  it('exports current records, audit history, and explicit no-advice safety metadata', () => {
    const state = createMedicationEvent(createEmptyMedicationState(), combinationInput, deterministicOptions());
    const csv = buildMedicationCSV(metadata, state);
    const auditCSV = buildMedicationAuditCSV(state);
    const jsonText = buildMedicationJSON(metadata, state, '2026-08-18T04:00:00.000Z');
    const json = JSON.parse(jsonText);

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('药物名称,剂量文本,单位,途径');
    expect(csv).toContain('医院自定义药物甲,人工填写剂量甲,自定义单位甲,人工填写途径甲');
    expect(csv).toContain('医院自定义药物乙,人工填写剂量乙,自定义单位乙,人工填写途径乙');
    expect(auditCSV).toContain('event-created');
    expect(auditCSV).toContain('人工填写剂量甲');
    expect(json.safety).toEqual(expect.objectContaining({
      humanEnteredOnly: true,
      doseCalculatedByApplication: false,
      clinicalRecommendation: false,
    }));
    expect(json.medicationState.events[0].medications).toHaveLength(2);
  });
});
