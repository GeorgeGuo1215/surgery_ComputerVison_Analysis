import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoSave } from './useAutoSave';
import { chooseSaveDirectory, saveHeartRateFile } from '../services/autoSave';
import { createSnapshot } from '../domain/recording';
import { DEFAULT_ROIS, emptyReadingMap } from '../domain/vitals';
import type { SessionState } from '../domain/types';

vi.mock('../services/autoSave', async (original) => ({
  ...await original<typeof import('../services/autoSave')>(),
  saveHeartRateFile: vi.fn(),
  chooseSaveDirectory: vi.fn(),
}));

function makeSession(): SessionState {
  return {
    version: 2, sessionId: 'test', startedAt: new Date().toISOString(),
    metadata: { caseId: '', patientName: '', species: '', weight: '', procedure: '', clinician: '' },
    rois: DEFAULT_ROIS, recordIntervalMinutes: 5,
    snapshots: [createSnapshot(emptyReadingMap(), 'scheduled')],
  };
}
const advance = async (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));

describe('five-minute file saving', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T02:00:00Z'));
    vi.mocked(saveHeartRateFile).mockReset().mockResolvedValue({ kind: 'saved', filename: 'test.csv', savedAt: new Date().toISOString() });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('waits five minutes, uses the latest rows and avoids duplicate unchanged backups', async () => {
    const session = makeSession();
    const { rerender } = renderHook(({ value }) => useAutoSave(value, true, true), { initialProps: { value: session } });
    await advance(299_999);
    expect(saveHeartRateFile).not.toHaveBeenCalled();
    const updated = { ...session, snapshots: [...session.snapshots, createSnapshot(emptyReadingMap(), 'scheduled')] };
    rerender({ value: updated });
    await advance(2);
    expect(saveHeartRateFile).toHaveBeenCalledExactlyOnceWith(updated, null);
    await advance(300_000);
    expect(saveHeartRateFile).toHaveBeenCalledTimes(1);
  });

  it('flushes on stop before five minutes, including offline completion', async () => {
    const session = makeSession();
    const { rerender } = renderHook(({ active }) => useAutoSave(session, active, true), { initialProps: { active: true } });
    await advance(10_000);
    rerender({ active: false });
    await advance(1001);
    expect(saveHeartRateFile).toHaveBeenCalledExactlyOnceWith(session, null);
  });

  it('handles 288 five-minute deadlines across a simulated day with all 289 rows retained', async () => {
    let session = makeSession();
    const anchor = Date.now();
    const { rerender } = renderHook(({ value }) => useAutoSave(value, true, true), { initialProps: { value: session } });
    for (let index = 1; index <= 288; index += 1) {
      vi.setSystemTime(anchor + index * 300_000 - 1000);
      const timestamp = new Date(anchor + index * 300_000).toISOString();
      session = { ...session, snapshots: [...session.snapshots, createSnapshot(emptyReadingMap(timestamp), 'scheduled', timestamp)] };
      rerender({ value: session });
      await advance(1000);
    }
    expect(saveHeartRateFile).toHaveBeenCalledTimes(288);
    expect(vi.mocked(saveHeartRateFile).mock.calls.at(-1)![0].snapshots).toHaveLength(289);
    expect(new Set(session.snapshots.map((row) => row.scheduledAt)).size).toBe(289);
  });

  it('defers a hidden-page stop until the page is visible and does not save empty sessions', async () => {
    const session = makeSession();
    const { rerender } = renderHook(({ active, visible, value }) => useAutoSave(value, active, visible), {
      initialProps: { active: true, visible: true, value: session },
    });
    rerender({ active: false, visible: false, value: session });
    await advance(400_000);
    expect(saveHeartRateFile).not.toHaveBeenCalled();
    rerender({ active: false, visible: true, value: session });
    await advance(1001);
    expect(saveHeartRateFile).toHaveBeenCalledTimes(1);
    rerender({ active: true, visible: true, value: { ...session, sessionId: 'empty', snapshots: [] } });
    await advance(300_001);
    expect(saveHeartRateFile).toHaveBeenCalledTimes(1);
  });

  it('keeps failed data available for explicit retry and reports the error', async () => {
    vi.mocked(saveHeartRateFile).mockRejectedValueOnce(new Error('磁盘空间不足'));
    const session = makeSession();
    const { result } = renderHook(() => useAutoSave(session, true, true));
    await advance(300_001);
    expect(result.current.error).toContain('磁盘空间不足');
    await advance(5000);
    expect(saveHeartRateFile).toHaveBeenCalledTimes(1);
    await act(async () => result.current.saveNow());
    expect(saveHeartRateFile).toHaveBeenLastCalledWith(session, null);
    expect(result.current.error).toBe('');
    expect(result.current.status).toContain('已保存到所选文件夹');
  });

  it('honors disabling, starts a new five-minute timer on enabling and supports folder selection', async () => {
    const session = makeSession();
    const directory = { name: 'HR记录', getFileHandle: vi.fn() };
    vi.mocked(chooseSaveDirectory).mockResolvedValue(directory);
    const { result } = renderHook(() => useAutoSave(session, true, true));
    act(() => result.current.setEnabled(false));
    await advance(400_000);
    expect(saveHeartRateFile).not.toHaveBeenCalled();
    await act(async () => result.current.selectDirectory());
    act(() => result.current.setEnabled(true));
    await advance(299_999);
    expect(saveHeartRateFile).not.toHaveBeenCalled();
    await advance(2);
    expect(saveHeartRateFile).toHaveBeenCalledExactlyOnceWith(session, directory);
  });

  it('serializes slow writes and flushes rows added while the final save was in flight', async () => {
    let finish!: (value: Awaited<ReturnType<typeof saveHeartRateFile>>) => void;
    vi.mocked(saveHeartRateFile).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const session = makeSession();
    const { rerender } = renderHook(({ value, active }) => useAutoSave(value, active, true), { initialProps: { value: session, active: true } });
    await advance(300_001);
    const updated = { ...session, snapshots: [...session.snapshots, createSnapshot(emptyReadingMap(), 'manual')] };
    rerender({ value: updated, active: false });
    await advance(10_000);
    expect(saveHeartRateFile).toHaveBeenCalledTimes(1);
    await act(async () => finish({ kind: 'saved', filename: 'test.csv', savedAt: new Date().toISOString() }));
    await advance(1001);
    expect(saveHeartRateFile).toHaveBeenCalledTimes(2);
    expect(saveHeartRateFile).toHaveBeenLastCalledWith(updated, null);
  });
});
