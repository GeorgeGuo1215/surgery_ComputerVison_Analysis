import { buildCSV, downloadText, safeFilenamePart } from '../domain/export';
import type { SessionState } from '../domain/types';

export const AUTO_SAVE_INTERVAL_MS = 5 * 60_000;

// Kept structural because directory pickers are not yet in TypeScript's DOM library.
export interface SaveDirectory {
  name: string;
  getFileHandle(name: string, options: { create: true }): Promise<{
    createWritable(): Promise<{
      write(data: string): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
  }>;
}

type DirectoryWindow = Window & {
  showDirectoryPicker?: (options: { mode: 'readwrite'; id: string }) => Promise<SaveDirectory>;
};

export function canChooseSaveDirectory(): boolean {
  return typeof (window as DirectoryWindow).showDirectoryPicker === 'function';
}

export async function chooseSaveDirectory(): Promise<SaveDirectory | null> {
  try {
    const picker = (window as DirectoryWindow).showDirectoryPicker;
    if (!picker) throw new Error('当前浏览器不支持选择文件夹，请使用 Chrome 桌面版。');
    return await picker.call(window, { mode: 'readwrite', id: 'petor-hr-autosave' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

export async function saveHeartRateFile(session: SessionState, directory: SaveDirectory | null) {
  const savedAt = new Date().toISOString();
  const suffix = directory ? '最新完整记录' : savedAt.replace(/[:.]/g, '-');
  const filename = `${safeFilenamePart(session.metadata.caseId || session.metadata.patientName)}_HR_RR_${safeFilenamePart(session.sessionId)}_${suffix}.csv`;
  const content = buildCSV(session.metadata, session.snapshots);
  if (!directory) {
    downloadText(content, filename, 'text/csv;charset=utf-8');
    // An anchor click only requests a download; Chrome does not expose completion.
    return { kind: 'download-requested' as const, filename, savedAt };
  }
  const file = await directory.getFileHandle(filename, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
  return { kind: 'saved' as const, filename, savedAt };
}
