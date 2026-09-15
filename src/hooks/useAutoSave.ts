import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionState } from '../domain/types';
import { AUTO_SAVE_INTERVAL_MS, chooseSaveDirectory, saveHeartRateFile } from '../services/autoSave';
import type { SaveDirectory } from '../services/autoSave';

export function useAutoSave(session: SessionState, active: boolean, visible: boolean) {
  const [enabled, setEnabled] = useState(true);
  const [directory, setDirectory] = useState<SaveDirectory | null>(null);
  const [status, setStatus] = useState('等待开始记录；每 5 分钟自动保存 CSV。');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveRequest, setSaveRequest] = useState(0);
  const latest = useRef({ session, enabled, directory, visible });
  const busy = useRef(false);
  const lastSaved = useRef<SessionState | null>(null);
  const pendingFinal = useRef(false);
  const wasActive = useRef(false);
  const nextDue = useRef<number | null>(null);

  useEffect(() => {
    latest.current = { session, enabled, directory, visible };
  }, [session, enabled, directory, visible]);

  const save = useCallback(async (force = false) => {
    const current = latest.current;
    if (busy.current || !current.visible || (!force && !current.enabled)) return;
    if (!current.session.snapshots.length) {
      pendingFinal.current = false;
      return;
    }
    if (!force && lastSaved.current === current.session) {
      pendingFinal.current = false;
      return;
    }
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await saveHeartRateFile(current.session, current.directory);
      lastSaved.current = current.session;
      pendingFinal.current = pendingFinal.current && latest.current.session !== current.session;
      setStatus(`${result.kind === 'saved' ? '已保存到所选文件夹' : '已请求 Chrome 下载，请检查下载列表'} · ${current.session.snapshots.length} 行 · ${new Date(result.savedAt).toLocaleTimeString()} · ${result.filename}`);
    } catch (cause) {
      setError(`自动保存失败，数据仍保留在当前页面。请重新选择文件夹或点击“立即保存 / 重试”。${cause instanceof Error ? cause.message : String(cause)}`);
      // Retry on the next five-minute deadline or an explicit click, not every second.
      pendingFinal.current = false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    if (active && enabled) {
      if (nextDue.current == null) nextDue.current = Date.now() + AUTO_SAVE_INTERVAL_MS;
    } else {
      nextDue.current = null;
    }
    if (wasActive.current && !active && enabled) pendingFinal.current = true;
    wasActive.current = active;
    if (!enabled) pendingFinal.current = false;
  }, [active, enabled]);

  useEffect(() => {
    const tick = () => {
      if (!latest.current.enabled || !latest.current.visible) return;
      if (!pendingFinal.current && (nextDue.current == null || Date.now() < nextDue.current)) return;
      if (busy.current) return;
      if (nextDue.current != null) nextDue.current = Date.now() + AUTO_SAVE_INTERVAL_MS;
      // Request through React so the scheduler's boundary row commits before export.
      setSaveRequest((value) => value + 1);
    };
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [save]);

  useEffect(() => {
    if (saveRequest > 0) void save();
  }, [saveRequest, save]);

  useEffect(() => {
    lastSaved.current = null;
    pendingFinal.current = false;
    setStatus('等待开始记录；每 5 分钟自动保存 CSV。');
    setError('');
  }, [session.sessionId]);

  const selectDirectory = async () => {
    try {
      const selected = await chooseSaveDirectory();
      if (!selected) return;
      setDirectory(selected);
      lastSaved.current = null;
      setError('');
      setStatus(`已选择 ${selected.name}；记录期间每 5 分钟保存，暂停或分析结束后补存。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return { enabled, setEnabled, directoryName: directory?.name, status, error, saving, selectDirectory, saveNow: () => save(true) };
}
