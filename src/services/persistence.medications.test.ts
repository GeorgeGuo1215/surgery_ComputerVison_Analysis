import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEmptyMedicationState,
  createMedicationEvent,
} from '../domain/medications';
import type { SessionState } from '../domain/types';
import { DEFAULT_ROIS } from '../domain/vitals';
import {
  LEGACY_SESSION_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  loadSession,
  saveSession,
} from './persistence';

function session(): SessionState {
  return {
    version: 2,
    sessionId: 'medication-persistence',
    startedAt: '2026-08-18T02:00:00.000Z',
    metadata: {
      caseId: 'MED-01',
      patientName: '测试动物',
      species: '犬',
      weight: '',
      procedure: '',
      clinician: '',
    },
    rois: { ...DEFAULT_ROIS },
    snapshots: [],
    recordIntervalMinutes: 5,
  };
}

describe('medication session persistence', () => {
  beforeEach(() => localStorage.clear());

  it('migrates a legacy session with no medication fields to an empty local medication state', () => {
    const legacy = { ...session(), version: 1 as const };
    localStorage.setItem(LEGACY_SESSION_STORAGE_KEY, JSON.stringify(legacy));

    const restored = loadSession();

    expect(restored?.medications).toEqual(createEmptyMedicationState());
    expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!).medications)
      .toEqual(createEmptyMedicationState());
  });

  it('round-trips hospital catalog, combination events, and audit locally', () => {
    const state = session();
    state.medications = createMedicationEvent(createEmptyMedicationState(), {
      phase: 'intraoperative-additional',
      administeredAt: '2026-08-18T02:15:00.000Z',
      medications: [
        { name: '医院药物甲', doseText: '人员填写甲', unit: '单位甲', route: '途径甲' },
        { name: '医院药物乙', doseText: '人员填写乙', unit: '单位乙', route: '途径乙' },
      ],
    }, {
      changedAt: '2026-08-18T02:16:00.000Z',
      makeId: (prefix) => `${prefix}-fixed`,
    });

    expect(saveSession(state).ok).toBe(true);
    const restored = loadSession();

    expect(restored?.medications?.events[0].medications).toHaveLength(2);
    expect(restored?.medications?.events[0]).toMatchObject({
      phase: 'intraoperative-additional',
      medications: [
        { name: '医院药物甲', doseText: '人员填写甲', unit: '单位甲', route: '途径甲' },
        { name: '医院药物乙', doseText: '人员填写乙', unit: '单位乙', route: '途径乙' },
      ],
    });
    expect(restored?.medications?.audit).toHaveLength(1);
  });
});
