import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseSaveDirectory, saveHeartRateFile } from './autoSave';
import { createSnapshot } from '../domain/recording';
import { DEFAULT_ROIS, emptyReadingMap } from '../domain/vitals';
import type { SessionState } from '../domain/types';

const session: SessionState = {
  version: 2, sessionId: 'session-test', startedAt: null,
  metadata: { caseId: 'OR/001', patientName: '', species: '', weight: '', procedure: '', clinician: '' },
  rois: DEFAULT_ROIS, recordIntervalMinutes: 5,
  snapshots: [createSnapshot(emptyReadingMap(), 'scheduled')],
};

describe('local CSV file writer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('updates the same complete session CSV in the chosen folder and waits for close', async () => {
    let finish!: () => void;
    const stream = { write: vi.fn().mockResolvedValue(undefined), close: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), abort: vi.fn() };
    const directory = { name: 'HR', getFileHandle: vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(stream) }) };
    let done = false;
    const pending = saveHeartRateFile(session, directory).then((result) => { done = true; return result; });
    await vi.waitFor(() => expect(stream.close).toHaveBeenCalled());
    expect(done).toBe(false);
    expect(directory.getFileHandle).toHaveBeenCalledWith('OR_001_HR_RR_session-test_最新完整记录.csv', { create: true });
    expect(stream.write).toHaveBeenCalledWith(expect.stringContaining('对齐时间ISO_UTC'));
    finish();
    expect((await pending).kind).toBe('saved');
    stream.close.mockResolvedValueOnce(undefined);
    await saveHeartRateFile(session, directory);
    expect(directory.getFileHandle.mock.calls[0][0]).toBe(directory.getFileHandle.mock.calls[1][0]);
  });

  it('aborts a failed write and propagates the failure', async () => {
    const stream = { write: vi.fn().mockRejectedValue(new Error('disk full')), close: vi.fn(), abort: vi.fn().mockResolvedValue(undefined) };
    const directory = { name: 'HR', getFileHandle: vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(stream) }) };
    await expect(saveHeartRateFile(session, directory)).rejects.toThrow('disk full');
    expect(stream.abort).toHaveBeenCalledTimes(1);
    expect(stream.close).not.toHaveBeenCalled();
  });

  it('treats directory chooser cancellation as no selection', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')));
    await expect(chooseSaveDirectory()).resolves.toBeNull();
  });
});
