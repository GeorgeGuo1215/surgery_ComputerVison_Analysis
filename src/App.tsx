import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrandMark } from './components/BrandMark';
import { CaseSetup } from './components/CaseSetup';
import { CorrectionDialog } from './components/CorrectionDialog';
import { MonitorStage } from './components/MonitorStage';
import { MedicationPanel } from './components/MedicationPanel';
import { RecordTable } from './components/RecordTable';
import { ReferenceComparisonPanel } from './components/ReferenceComparisonPanel';
import { VitalGrid } from './components/VitalGrid';
import {
  buildCSV,
  buildMedicationAuditCSV,
  buildMedicationCSV,
  buildMedicationJSON,
  projectSessionForExport,
  safeFilenamePart,
  saveOrShareText,
} from './domain/export';
import {
  createHeartRateStabilizationState,
  stabilizeHeartRateReading,
} from './domain/heartRateStabilization';
import { buildOfflineAnalysisPlan, buildOfflineSampleSlots, consensusReading, formatMediaTime } from './domain/offline';
import { createEmptyMedicationState, normalizeMedicationState } from './domain/medications';
import { detectPlatformCapabilities, manualInstallInstructions } from './domain/platform';
import {
  buildHeartRateComparisonCSV,
  buildHeartRateComparisonJSON,
  compareHeartRateSnapshots,
  defaultAlignmentTolerance,
  parseHeartRateReferenceCSV,
} from './domain/referenceComparison';
import type { HeartRateReferenceDataset } from './domain/referenceComparison';
import { calculateSnapshotQuality, createSnapshot, millisecondsUntilNextRecord } from './domain/recording';
import type {
  CaptureMode,
  NormalizedROI,
  ReadingMap,
  RecordSnapshot,
  SessionState,
  VitalKey,
  VitalReading,
} from './domain/types';
import {
  DEFAULT_ROIS,
  ACTIVE_VITAL_DEFINITIONS,
  ACTIVE_VITAL_KEYS,
  DEFERRED_VITAL_KEYS,
  MINDRAY_IMEC8_REFERENCE_VIDEO_ROIS,
  MINDRAY_IMEC8_VIDEO_ROIS,
  VITAL_BY_KEY,
  VITAL_KEYS,
  emptyReadingMap,
  evaluateReading,
  formatDemoReading,
  isAcceptedHeartRateReading,
  parseManualHeartRateInput,
  parseVitalText,
  valuesWithinCaptureRange,
} from './domain/vitals';
import { useCamera } from './hooks/useCamera';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { useSpeechReadiness } from './hooks/useSpeechReadiness';
import { useVideoFile } from './hooks/useVideoFile';
import { useWakeLock } from './hooks/useWakeLock';
import { BrowserOCR, captureFrozenFrame, cropAndPreprocess, cropRawForOCR } from './services/ocr';
import { clearPersistedSession, loadSession, saveSession } from './services/persistence';
import { snapshotSpeech } from './services/speech';
import { seekVideoFrame } from './services/video';

const BLANK_METADATA = {
  caseId: '',
  patientName: '',
  species: '',
  weight: '',
  procedure: '',
  clinician: '',
};

type OfflineAnalysisStatus = 'idle' | 'ready' | 'running' | 'cancelling' | 'completed' | 'error';

interface OfflineAnalysisState {
  status: OfflineAnalysisStatus;
  completedUnits: number;
  totalUnits: number;
  completedSlots: number;
  totalSlots: number;
  currentMetric: string;
  currentMediaTime: number;
  message: string;
}

const EMPTY_OFFLINE_ANALYSIS: OfflineAnalysisState = {
  status: 'idle',
  completedUnits: 0,
  totalUnits: 0,
  completedSlots: 0,
  totalSlots: 0,
  currentMetric: '',
  currentMediaTime: 0,
  message: '',
};

function cropVitalForOCR(
  key: VitalKey,
  source: HTMLCanvasElement,
  roi: NormalizedROI,
): HTMLCanvasElement {
  return key === 'rr'
    ? cropAndPreprocess(source, source.width, source.height, roi)
    : cropRawForOCR(source, source.width, source.height, roi);
}

function makeSession(): SessionState {
  return {
    version: 2,
    sessionId: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
    startedAt: null,
    metadata: BLANK_METADATA,
    rois: { ...DEFAULT_ROIS },
    snapshots: [],
    recordIntervalMinutes: 5,
    medications: createEmptyMedicationState(),
  };
}

function restoreSession(): SessionState {
  const stored = loadSession();
  if (!stored) return makeSession();
  return {
    ...stored,
    metadata: { ...BLANK_METADATA, ...stored.metadata },
    rois: { ...DEFAULT_ROIS, ...stored.rois },
    snapshots: stored.snapshots.map((snapshot) => ({
      ...snapshot,
      scheduledAt: snapshot.scheduledAt ?? snapshot.recordedAt,
      audit: snapshot.audit ?? [],
    })),
  };
}

function makeHistory(): Record<VitalKey, VitalReading[]> {
  return Object.fromEntries(VITAL_KEYS.map((key) => [key, []])) as unknown as Record<VitalKey, VitalReading[]>;
}

function formatCountdown(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function missedReadingMap(reason: string, capturedAt: string): ReadingMap {
  const readings = emptyReadingMap(capturedAt);
  for (const key of ACTIVE_VITAL_KEYS) {
    readings[key] = {
      ...readings[key],
      status: 'not-found',
      reason,
    };
  }
  return readings;
}

function freshReadings(readings: ReadingMap, scheduledAt: string, mode: CaptureMode, isVisible: boolean): ReadingMap {
  if (!isVisible) return missedReadingMap('页面在后台，本时间槽未自动回填', scheduledAt);
  const copy = structuredClone(readings);
  const scheduleMs = Date.parse(scheduledAt);
  for (const key of ACTIVE_VITAL_KEYS) {
    const reading = copy[key];
    const age = scheduleMs - Date.parse(reading.capturedAt);
    if (mode === 'idle' || age > 15_000 || age < -30_000) {
      copy[key] = {
        ...reading,
        display: null,
        values: [],
        status: 'not-found',
        reason: mode === 'idle' ? '没有活动视频源' : '最近可靠读数已超过 15 秒',
      };
    }
  }
  return copy;
}

function App() {
  const [session, setSession] = useState<SessionState>(() => restoreSession());
  const [readings, setReadings] = useState<ReadingMap>(() => emptyReadingMap());
  const [history, setHistory] = useState<Record<VitalKey, VitalReading[]>>(() => makeHistory());
  const [mode, setMode] = useState<CaptureMode>('idle');
  const [monitoring, setMonitoring] = useState(false);
  const [selectedROI, setSelectedROI] = useState<VitalKey | null>(null);
  const [speechEnabled, setSpeechEnabled] = useState(false);
  const [ocrProgress, setOCRProgress] = useState({ progress: 0, status: '等待启动' });
  const [activeOCRKey, setActiveOCRKey] = useState<VitalKey | null>(null);
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible');
  const [now, setNow] = useState(Date.now());
  const [notice, setNotice] = useState('');
  const [mediaAspectRatio, setMediaAspectRatio] = useState(16 / 9);
  const [offlineIntervalSeconds, setOfflineIntervalSeconds] = useState(300);
  const [videoStartAtLocal, setVideoStartAtLocal] = useState('');
  const [videoCompatibilityWarning, setVideoCompatibilityWarning] = useState('');
  const [persistenceWarning, setPersistenceWarning] = useState('');
  const [referenceDataset, setReferenceDataset] = useState<HeartRateReferenceDataset | null>(null);
  const [referenceError, setReferenceError] = useState('');
  const [referenceOffsetSeconds, setReferenceOffsetSeconds] = useState(0);
  const [referenceToleranceSeconds, setReferenceToleranceSeconds] = useState(0.5);
  const [offlineAnalysis, setOfflineAnalysis] = useState<OfflineAnalysisState>(EMPTY_OFFLINE_ANALYSIS);
  const [correctionTarget, setCorrectionTarget] = useState<{
    snapshotId: string;
    key: VitalKey;
    currentValue: string | null;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement>(null);
  const readingsRef = useRef(readings);
  const historyRef = useRef(history);
  const sessionRef = useRef(session);
  const modeRef = useRef(mode);
  const pageVisibleRef = useRef(pageVisible);
  const visibilityInterruptionsRef = useRef<Array<{ hiddenAt: number; visibleAt: number | null }>>(
    document.visibilityState === 'hidden' ? [{ hiddenAt: Date.now(), visibleAt: null }] : [],
  );
  const consensusRef = useRef<Record<VitalKey, VitalReading[]>>(makeHistory());
  const heartRateStabilizationRef = useRef(createHeartRateStabilizationState());
  const ocrRef = useRef<BrowserOCR | null>(null);
  const offlineCancelRef = useRef(false);
  const videoFile = useVideoFile();
  const camera = useCamera(videoRef);
  const platform = useMemo(() => detectPlatformCapabilities(), []);
  const installPrompt = useInstallPrompt();
  const speech = useSpeechReadiness();
  const wakeLock = useWakeLock(monitoring || offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling');
  const offlinePlan = useMemo(() => buildOfflineAnalysisPlan(offlineIntervalSeconds), [offlineIntervalSeconds]);

  const referenceReport = useMemo(() => {
    const sourceVideoName = videoFile.metadata?.name;
    if (!referenceDataset || !sourceVideoName) return null;
    return compareHeartRateSnapshots(
      session.snapshots,
      referenceDataset,
      sourceVideoName,
      Number.isFinite(referenceOffsetSeconds) ? referenceOffsetSeconds : 0,
      Number.isFinite(referenceToleranceSeconds) && referenceToleranceSeconds > 0
        ? referenceToleranceSeconds
        : defaultAlignmentTolerance(referenceDataset),
    );
  }, [referenceDataset, referenceOffsetSeconds, referenceToleranceSeconds, session.snapshots, videoFile.metadata?.name]);

  if (!ocrRef.current) {
    ocrRef.current = new BrowserOCR((progress, status) => {
      setOCRProgress({ progress, status });
    });
  }

  useEffect(() => {
    readingsRef.current = readings;
  }, [readings]);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    sessionRef.current = session;
    const result = saveSession(session);
    setPersistenceWarning(result.ok
      ? ''
      : result.code === 'quota-exceeded'
        ? '浏览器存储空间不足，当前草稿未保存。请立即导出 CSV 和 JSON。'
        : '浏览器本机存储不可用，当前草稿未保存。请保持页面打开并及时导出。');
  }, [session]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    pageVisibleRef.current = pageVisible;
  }, [pageVisible]);

  useEffect(() => {
    if (mode !== 'video') return;
    if (videoFile.status === 'ready') {
      setOfflineAnalysis((current) => current.status === 'idle' ? { ...current, status: 'ready', message: '视频已就绪，可校准后开始分析。' } : current);
    } else if (videoFile.status === 'error') {
      setOfflineAnalysis((current) => ({ ...current, status: 'error', message: videoFile.error }));
    }
  }, [mode, videoFile.error, videoFile.status]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const onVisibility = () => {
      const visible = document.visibilityState === 'visible';
      const changedAt = Date.now();
      pageVisibleRef.current = visible;
      if (!visible) {
        setMonitoring(false);
        visibilityInterruptionsRef.current = [
          ...visibilityInterruptionsRef.current,
          { hiddenAt: changedAt, visibleAt: null },
        ].slice(-32);
        heartRateStabilizationRef.current = {
          ...heartRateStabilizationRef.current,
          pendingJump: null,
        };
        consensusRef.current.hr = [];
      } else {
        const interruptions = [...visibilityInterruptionsRef.current];
        const last = interruptions.at(-1);
        if (last && last.visibleAt == null) interruptions[interruptions.length - 1] = { ...last, visibleAt: changedAt };
        visibilityInterruptionsRef.current = interruptions;
        if (last) {
          setNotice('页面已从后台恢复。自动记录仍处于暂停，请检查相机画面和 HR 识别框后手动继续。');
        }
      }
      setPageVisible(visible);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(''), 3600);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const commitReading = (candidate: VitalReading) => {
    const key = candidate.key;
    const recentCandidates = [...consensusRef.current[key], candidate].slice(-3);
    consensusRef.current[key] = recentCandidates;
    let committed = candidate;
    if (candidate.status === 'ok') {
      const previous = recentCandidates.at(-2);
      if (previous?.status !== 'ok' || previous.display !== candidate.display) {
        committed = {
          ...candidate,
          status: 'low-confidence',
          reason: '等待至少两次连续识别一致',
        };
      }
    }
    if (key === 'hr') {
      const decision = stabilizeHeartRateReading(heartRateStabilizationRef.current, committed);
      heartRateStabilizationRef.current = decision.state;
      committed = decision.reading;
    }
    setReadings((current) => ({ ...current, [key]: committed }));
    setHistory((current) => ({ ...current, [key]: [...current[key], committed].slice(-120) }));
  };

  useEffect(() => {
    if (mode !== 'demo') return;
    const updateDemo = () => {
      const timestamp = new Date().toISOString();
      const phase = Date.now() / 1000;
      const next = emptyReadingMap(timestamp);
      for (const definition of ACTIVE_VITAL_DEFINITIONS) {
        const base = definition.demoValue;
        const values = base.map((value, index) => {
          if (definition.key === 'spo2') return Math.max(96, Math.min(100, Math.round(value + Math.sin(phase / 5))));
          if (definition.key === 'temp') return Number((value + Math.sin(phase / 19) * 0.2).toFixed(1));
          if (definition.key === 'nibp') return Math.round(value + Math.sin(phase / 9 + index) * 2);
          if (definition.key === 'fico2') return value;
          return Math.round(value + Math.sin(phase / 4 + index) * (definition.key === 'hr' ? 3 : 1));
        });
        next[definition.key] = formatDemoReading(definition.key, values, timestamp);
      }
      setReadings(next);
      setHistory((current) => {
        const updated = { ...current };
        for (const key of ACTIVE_VITAL_KEYS) updated[key] = [...updated[key], next[key]].slice(-120);
        return updated;
      });
    };
    updateDemo();
    const interval = window.setInterval(updateDemo, 1000);
    setOCRProgress({ progress: 1, status: '模拟信号稳定' });
    return () => window.clearInterval(interval);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'camera' || camera.status !== 'live') return;
    let cancelled = false;
    let timeout = 0;
    let currentKey: VitalKey | null = null;

    const scan = async () => {
      if (!pageVisibleRef.current) {
        timeout = window.setTimeout(scan, 500);
        return;
      }
      const video = videoRef.current;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) {
        timeout = window.setTimeout(scan, 500);
        return;
      }

      try {
        const frozenFrame = captureFrozenFrame(video, video.videoWidth, video.videoHeight);
        for (const definition of ACTIVE_VITAL_DEFINITIONS) {
          if (cancelled) return;
          currentKey = definition.key;
          const roi = sessionRef.current.rois[definition.key];
          if (!roi) continue;
          setActiveOCRKey(definition.key);
          const crop = cropVitalForOCR(definition.key, frozenFrame, roi);
          const result = await ocrRef.current!.recognize(crop);
          if (cancelled) return;
          const capturedAt = new Date().toISOString();
          const candidate = evaluateReading(
            definition.key,
            result.text,
            result.confidence,
            capturedAt,
          );
          commitReading(candidate);
          currentKey = null;
        }
        setOCRProgress({ progress: 1, status: '本地 OCR 已完成一轮' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (currentKey) {
          const capturedAt = new Date().toISOString();
          commitReading({
            key: currentKey,
            display: null,
            values: [],
            rawText: '',
            confidence: 0,
            status: 'not-found',
            capturedAt,
            reason: `OCR 失败：${message}；已中断连续跳变确认`,
          });
        }
        setOCRProgress({ progress: 0, status: `OCR 不可用：${message}` });
      } finally {
        setActiveOCRKey(null);
        if (!cancelled) timeout = window.setTimeout(scan, 1200);
      }
    };

    void scan();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      setActiveOCRKey(null);
      heartRateStabilizationRef.current = {
        ...heartRateStabilizationRef.current,
        pendingJump: null,
      };
      consensusRef.current.hr = [];
    };
  }, [camera.status, mode]);

  const announce = useCallback(async (text: string) => {
    const result = await speech.testSpeech(text);
    if (result.outcome === 'error') {
      setSpeechEnabled(false);
      setNotice(`${result.error}自动播报已关闭，请以页面记录为准。`);
    }
    return result;
  }, [speech.testSpeech]);

  const testChineseSpeech = useCallback(async () => {
    const result = await speech.testSpeech('语音测试。宠物手术监护辅助记录已就绪。');
    if (result.outcome === 'end') {
      setSpeechEnabled(true);
      setNotice('简体中文播报测试通过，已开启记录后播报。');
    } else {
      setSpeechEnabled(false);
      setNotice(`${result.error}请以页面视觉记录为准。`);
    }
  }, [speech.testSpeech]);

  const appendSnapshots = (rows: RecordSnapshot[]) => {
    if (rows.length === 0) return;
    setSession((current) => ({ ...current, snapshots: [...current.snapshots, ...rows] }));
    if (speechEnabled) void announce(snapshotSpeech(rows.at(-1)!.readings));
  };

  useEffect(() => {
    if (!monitoring || !session.startedAt) return;
    const tick = () => {
      const currentSession = sessionRef.current;
      if (!currentSession.startedAt) return;
      const anchor = Date.parse(currentSession.startedAt);
      const intervalMs = currentSession.recordIntervalMinutes * 60_000;
      if (!Number.isFinite(anchor) || intervalMs <= 0) return;
      const currentTime = Date.now();
      const dueIndex = Math.floor((currentTime - anchor) / intervalMs);
      if (dueIndex < 0) return;
      const existing = new Set(
        currentSession.snapshots
          .filter((snapshot) => snapshot.source === 'scheduled')
          .map((snapshot) => Math.round((Date.parse(snapshot.scheduledAt) - anchor) / intervalMs)),
      );
      const rows: RecordSnapshot[] = [];
      for (let index = 0; index <= dueIndex; index += 1) {
        if (existing.has(index)) continue;
        const scheduledAt = new Date(anchor + index * intervalMs).toISOString();
        const scheduledMs = Date.parse(scheduledAt);
        const delay = currentTime - Date.parse(scheduledAt);
        const activeSource = modeRef.current !== 'idle' && (modeRef.current !== 'camera' || camera.status === 'live');
        const scheduledDuringHidden = visibilityInterruptionsRef.current.some(({ hiddenAt, visibleAt }) => (
          scheduledMs >= hiddenAt && scheduledMs <= (visibleAt ?? currentTime)
        ));
        const selectedReadings =
          scheduledDuringHidden || delay > 30_000 || !activeSource
            ? missedReadingMap(
                scheduledDuringHidden
                  ? '计划时间点位于页面后台期间，本槽记为缺失且不回填'
                  : delay > 30_000
                    ? '浏览器休眠或暂停，已错过固定时间槽'
                    : '摄像头不可用',
                scheduledAt,
              )
            : freshReadings(readingsRef.current, scheduledAt, modeRef.current, pageVisibleRef.current);
        rows.push(createSnapshot(
          selectedReadings,
          'scheduled',
          new Date().toISOString(),
          scheduledAt,
          { inputSource: modeRef.current === 'idle' ? undefined : modeRef.current },
        ));
      }
      appendSnapshots(rows);
    };
    tick();
    const scheduler = window.setInterval(tick, 1000);
    return () => window.clearInterval(scheduler);
  }, [camera.status, monitoring, session.recordIntervalMinutes, session.startedAt, speechEnabled]);

  useEffect(
    () => () => {
      offlineCancelRef.current = true;
      void ocrRef.current?.terminate();
    },
    [],
  );

  const nextRecordIn = useMemo(() => {
    if (!monitoring || !session.startedAt) return session.recordIntervalMinutes * 60_000;
    const scheduledRows = session.snapshots.filter((snapshot) => snapshot.source === 'scheduled');
    const last = scheduledRows.at(-1)?.scheduledAt ?? null;
    return millisecondsUntilNextRecord(session.startedAt, last, session.recordIntervalMinutes, now);
  }, [monitoring, now, session.recordIntervalMinutes, session.snapshots, session.startedAt]);

  const clearReferenceDataset = () => {
    setReferenceDataset(null);
    setReferenceError('');
    setReferenceOffsetSeconds(0);
    setReferenceToleranceSeconds(0.5);
  };

  const selectReferenceFile = async (file: File) => {
    if (offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling') {
      setNotice('请先停止离线视频分析再更换参考文件。');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      setReferenceError('请选择 CSV 文件。');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setReferenceError('参考 CSV 超过 20 MB，请先拆分或精简后再导入。');
      return;
    }
    setReferenceError('');
    try {
      const dataset = parseHeartRateReferenceCSV(await file.text(), file.name, {
        sizeBytes: file.size,
        lastModified: file.lastModified,
      });
      setReferenceDataset(dataset);
      setReferenceOffsetSeconds(0);
      setReferenceToleranceSeconds(defaultAlignmentTolerance(dataset));
      setNotice(`已导入 ${dataset.samples.length} 个 HR 参考点。这是工程参考源，不是临床真值。`);
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : String(error));
    }
  };

  const startCamera = async () => {
    if (offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling') {
      setNotice('请先停止离线视频分析。');
      return;
    }
    if (monitoring) setMonitoring(false);
    offlineCancelRef.current = true;
    videoFile.clear();
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
    setOfflineAnalysis(EMPTY_OFFLINE_ANALYSIS);
    setVideoCompatibilityWarning('');
    clearReferenceDataset();
    setMediaAspectRatio(16 / 9);
    setSelectedROI(null);
    setReadings(emptyReadingMap());
    setHistory(makeHistory());
    consensusRef.current = makeHistory();
    heartRateStabilizationRef.current = createHeartRateStabilizationState();
    setMode('camera');
    const started = await camera.start();
    if (started) {
      setNotice('摄像头已连接。当前只分析 HR，请检查心率 ROI 只包含心率数字。');
    } else {
      setMode('idle');
    }
  };

  const startDemo = () => {
    if (offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling') {
      setNotice('请先停止离线视频分析。');
      return;
    }
    if (monitoring) setMonitoring(false);
    offlineCancelRef.current = true;
    camera.stop();
    videoFile.clear();
    setOfflineAnalysis(EMPTY_OFFLINE_ANALYSIS);
    setVideoCompatibilityWarning('');
    clearReferenceDataset();
    setMediaAspectRatio(16 / 9);
    setSelectedROI(null);
    setReadings(emptyReadingMap());
    setHistory(makeHistory());
    consensusRef.current = makeHistory();
    heartRateStabilizationRef.current = createHeartRateStabilizationState();
    setMode('demo');
    setSession((current) => ({ ...current, rois: { ...DEFAULT_ROIS } }));
    setNotice('已进入 HR 演示模式：心率为模拟值，仅用于验收记录、播报和导出流程。');
  };

  const selectVideoFile = (file: File) => {
    if (offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling') {
      setNotice('请先停止当前离线视频分析。');
      return;
    }
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
      setNotice('请选择 MP4、MOV、M4V 或 WebM 视频文件。');
      return;
    }
    setMonitoring(false);
    offlineCancelRef.current = true;
    camera.stop();
    setMode('video');
    setMediaAspectRatio(9 / 16);
    setOfflineAnalysis(EMPTY_OFFLINE_ANALYSIS);
    clearReferenceDataset();
    setSelectedROI(null);
    setReadings(emptyReadingMap());
    setHistory(makeHistory());
    consensusRef.current = makeHistory();
    heartRateStabilizationRef.current = createHeartRateStabilizationState();
    const isReferenceFixture = file.name === '1.mp4' && file.size === 92_268_591;
    setSession((current) => ({
      ...current,
      rois: { ...(isReferenceFixture ? MINDRAY_IMEC8_REFERENCE_VIDEO_ROIS : MINDRAY_IMEC8_VIDEO_ROIS) },
    }));
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    const mimeType = file.type || (extension === 'mov' ? 'video/quicktime' : extension === 'mp4' || extension === 'm4v' ? 'video/mp4' : '');
    const mediaProbe = document.createElement('video');
    const support = mimeType ? mediaProbe.canPlayType(mimeType) : 'maybe';
    setVideoCompatibilityWarning(
      isReferenceFixture
        ? '已识别 10:02 参考视频并应用其独立 ROI 布局；末段机位有移动，分析前仍需检查识别框。'
        : support === ''
        ? '此浏览器未声明支持该视频格式，将继续尝试解码；若失败，请转为 H.264/AAC MP4。'
        : extension === 'mov' && platform.kind !== 'ios' && platform.kind !== 'macos'
          ? 'Windows/Android 对 MOV 编码支持不一致；若无法打开，请转为 H.264/AAC MP4。'
          : '',
    );
    videoFile.load(file);
    setOCRProgress({ progress: 0, status: '等待视频解码' });
    setNotice(isReferenceFixture
      ? '视频仅在本机打开。已应用 10:02 附件视频的独立布局，请检查 HR 框是否覆盖数字。'
      : '视频仅在本机浏览器中打开。已应用迈瑞 iMEC8 Vet 初始布局，请先检查 HR 识别框。');
  };

  const handleVideoReady = (video: HTMLVideoElement) => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setMediaAspectRatio(video.videoWidth / video.videoHeight);
    }
    if (modeRef.current === 'video') {
      videoFile.markReady(video);
      if (video.videoWidth !== 544 || video.videoHeight !== 960) {
        setVideoCompatibilityWarning('视频已成功解码；迈瑞样本布局按 544×960 标定，请逐项重画 ROI 后再分析。');
      }
    }
  };

  const cancelOfflineAnalysis = () => {
    if (offlineAnalysis.status !== 'running') return;
    offlineCancelRef.current = true;
    setOfflineAnalysis((current) => ({ ...current, status: 'cancelling', message: '正在完成当前识别单元后停止…' }));
  };

  useEffect(() => {
    if (pageVisible || offlineAnalysis.status !== 'running') return;
    offlineCancelRef.current = true;
    setOfflineAnalysis((current) => ({
      ...current,
      status: 'cancelling',
      message: '页面进入后台，正在安全停止；已完成时间槽会保留。',
    }));
  }, [offlineAnalysis.status, pageVisible]);

  useEffect(() => {
    const onPageHide = () => {
      offlineCancelRef.current = true;
      saveSession(sessionRef.current);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setMonitoring(false);
      offlineCancelRef.current = true;
      if (modeRef.current === 'camera') {
        camera.stop();
        setMode('idle');
      }
      setOfflineAnalysis((current) => (
        current.status === 'running' || current.status === 'cancelling'
          ? { ...current, status: 'ready', currentMetric: '', message: '页面已恢复，请重新开始离线分析。' }
          : current
      ));
      setNotice('页面从系统后台恢复。为避免回填旧值，自动记录已暂停，请检查画面后手动恢复。');
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [camera.stop]);

  const runOfflineAnalysis = async () => {
    const video = videoRef.current;
    const metadata = videoFile.metadata;
    if (!video || videoFile.status !== 'ready' || !metadata) {
      setNotice('请先导入并成功加载视频。');
      return;
    }
    if (offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling') return;

    const priorRows = sessionRef.current.snapshots.filter(
      (snapshot) => snapshot.inputSource === 'video' && snapshot.sourceFileName === metadata.name,
    );
    if (priorRows.length > 0) {
      const replace = window.confirm(`当前表中已有 ${priorRows.length} 条来自同名视频的记录。重新分析将替换这些记录，是否继续？`);
      if (!replace) return;
    }
    const replacingPriorRows = priorRows.length > 0;

    const plan = buildOfflineAnalysisPlan(offlineIntervalSeconds);
    const analysisDefinitions = ACTIVE_VITAL_DEFINITIONS.filter(({ key }) => plan.metricKeys.includes(key));
    const slots = buildOfflineSampleSlots(
      metadata.durationSeconds,
      offlineIntervalSeconds,
      plan.consensusFrames,
      plan.frameSpacingSeconds,
      plan.firstSlotCenterSeconds,
    );
    if (slots.length === 0) {
      setOfflineAnalysis((current) => ({ ...current, status: 'error', message: '无法生成有效的视频采样时间槽。' }));
      return;
    }

    const startAt = videoStartAtLocal ? new Date(videoStartAtLocal) : null;
    if (startAt && !Number.isFinite(startAt.getTime())) {
      setNotice('视频起始时间格式无效，请重新填写或留空。');
      return;
    }

    const totalUnits = slots.reduce((sum, slot) => sum + slot.frameTimesSeconds.length * analysisDefinitions.length, 0);
    const analysisRunId = globalThis.crypto?.randomUUID?.() ?? String(Date.now());
    const fallbackAnchor = Date.now();
    const offlineHistory = makeHistory();
    let offlineHeartRateStabilization = createHeartRateStabilizationState();
    let completedUnits = 0;
    let completedSlots = 0;
    let pendingSnapshots: RecordSnapshot[] = [];
    let stagedReplacementSnapshots: RecordSnapshot[] = [];
    let lastCompletedReadings: ReadingMap | null = null;
    const flushPendingSnapshots = () => {
      if (pendingSnapshots.length === 0) return;
      const batch = pendingSnapshots;
      pendingSnapshots = [];
      if (replacingPriorRows) {
        stagedReplacementSnapshots = [...stagedReplacementSnapshots, ...batch];
      } else {
        setSession((current) => {
          const existing = new Set(
            current.snapshots
              .filter((snapshot) => snapshot.analysisRunId === analysisRunId)
              .map((snapshot) => snapshot.mediaTimeSeconds),
          );
          const additions = batch.filter((snapshot) => !existing.has(snapshot.mediaTimeSeconds));
          return additions.length === 0
            ? current
            : { ...current, snapshots: [...current.snapshots, ...additions] };
        });
      }
      if (lastCompletedReadings) {
        setReadings(lastCompletedReadings);
        setHistory(structuredClone(offlineHistory));
      }
    };
    const commitStagedReplacement = () => {
      if (!replacingPriorRows) return;
      setSession((current) => ({
        ...current,
        snapshots: [
          ...current.snapshots.filter(
            (snapshot) => !(snapshot.inputSource === 'video' && snapshot.sourceFileName === metadata.name),
          ),
          ...stagedReplacementSnapshots,
        ],
      }));
    };
    offlineCancelRef.current = false;
    video.pause();
    setSelectedROI(null);
    setOfflineAnalysis({
      status: 'running',
      completedUnits: 0,
      totalUnits,
      completedSlots: 0,
      totalSlots: slots.length,
      currentMetric: '',
      currentMediaTime: 0,
      message: plan.mode === 'hr-per-second'
        ? '正在初始化逐秒 HR 本地 OCR…'
        : '正在初始化本地 OCR…',
    });

    try {
      await ocrRef.current!.initialize();
      for (const slot of slots) {
        if (offlineCancelRef.current) throw new Error('OFFLINE_ANALYSIS_CANCELLED');
        const candidates = makeHistory();
        const scheduledMilliseconds = (startAt?.getTime() ?? fallbackAnchor) + slot.mediaTimeSeconds * 1000;
        const scheduledAt = new Date(scheduledMilliseconds).toISOString();
        if (plan.mode === 'hr-per-second') {
          setOfflineAnalysis((current) => ({
            ...current,
            currentMetric: '心率',
            currentMediaTime: slot.mediaTimeSeconds,
            message: `逐秒分析 ${formatMediaTime(slot.mediaTimeSeconds)} · HR 三帧共识`,
          }));
        }

        for (const frameTime of slot.frameTimesSeconds) {
          if (offlineCancelRef.current) throw new Error('OFFLINE_ANALYSIS_CANCELLED');
          const actualMediaTime = await seekVideoFrame(video, frameTime);
          const frozenFrame = captureFrozenFrame(video, video.videoWidth, video.videoHeight);
          for (const definition of analysisDefinitions) {
            if (offlineCancelRef.current) throw new Error('OFFLINE_ANALYSIS_CANCELLED');
            setActiveOCRKey(definition.key);
            if (plan.mode !== 'hr-per-second') {
              setOfflineAnalysis((current) => ({
                ...current,
                currentMetric: definition.label,
                currentMediaTime: actualMediaTime,
                message: `分析 ${formatMediaTime(slot.mediaTimeSeconds)} 时间槽`,
              }));
            }
            const roi = sessionRef.current.rois[definition.key];
            let candidate: VitalReading;
            if (!roi) {
              candidate = {
                key: definition.key,
                display: null,
                values: [],
                rawText: '',
                confidence: 0,
                status: 'not-configured',
                capturedAt: scheduledAt,
                reason: '未配置识别区域',
              };
            } else {
              try {
                const crop = cropVitalForOCR(definition.key, frozenFrame, roi);
                const result = await ocrRef.current!.recognize(crop);
                candidate = evaluateReading(
                  definition.key,
                  result.text,
                  result.confidence,
                  scheduledAt,
                );
              } catch (error) {
                candidate = {
                  key: definition.key,
                  display: null,
                  values: [],
                  rawText: '',
                  confidence: 0,
                  status: 'not-found',
                  capturedAt: scheduledAt,
                  reason: `单项 OCR 失败：${error instanceof Error ? error.message : String(error)}`,
                };
              }
            }
            candidates[definition.key].push(candidate);
            completedUnits += 1;
            if (plan.mode !== 'hr-per-second' || completedUnits % plan.consensusFrames === 0) {
              setOfflineAnalysis((current) => ({ ...current, completedUnits }));
            }
          }
        }

        const slotReadings = emptyReadingMap(scheduledAt);
        for (const key of plan.metricKeys) {
          const consensus = consensusReading(key, candidates[key], scheduledAt);
          if (key === 'hr') {
            const decision = stabilizeHeartRateReading(offlineHeartRateStabilization, consensus);
            offlineHeartRateStabilization = decision.state;
            slotReadings[key] = decision.reading;
          } else {
            slotReadings[key] = consensus;
          }
          offlineHistory[key] = [...offlineHistory[key], slotReadings[key]].slice(-20);
        }
        const analyzedAt = new Date().toISOString();
        const snapshot = createSnapshot(slotReadings, 'scheduled', analyzedAt, scheduledAt, {
          inputSource: 'video',
          mediaTimeSeconds: slot.mediaTimeSeconds,
          sourceFileName: metadata.name,
          videoStartAt: startAt?.toISOString(),
          analyzedAt,
          analysisRunId,
        });
        pendingSnapshots.push(snapshot);
        lastCompletedReadings = slotReadings;
        completedSlots += 1;
        const shouldFlush = pendingSnapshots.length >= plan.snapshotBatchSize || completedSlots === slots.length;
        if (shouldFlush) flushPendingSnapshots();
        setOfflineAnalysis((current) => ({ ...current, completedSlots }));
      }

      flushPendingSnapshots();
      commitStagedReplacement();
      setOfflineAnalysis((current) => ({
        ...current,
        status: 'completed',
        completedUnits: totalUnits,
        completedSlots: slots.length,
        currentMetric: '',
        message: plan.mode === 'hr-per-second'
          ? `完成 ${slots.length} 个逐秒 HR 时间槽，请查看参考对比并人工复核。`
          : `完成 ${slots.length} 个视频时间槽，请逐格人工核对。`,
      }));
      setOCRProgress({ progress: 1, status: '离线视频分析完成' });
      if (speechEnabled) void announce(`离线视频分析完成，共生成${slots.length}个时间点，请人工核对。`);
      setNotice(`离线分析完成：生成 ${slots.length} 行记录，原视频未上传。`);
    } catch (error) {
      flushPendingSnapshots();
      if (error instanceof Error && error.message === 'OFFLINE_ANALYSIS_CANCELLED') {
        const message = replacingPriorRows
          ? `分析已停止；旧的 ${priorRows.length} 条结果已保留，本次 ${completedSlots} 个完整时间槽未替换旧结果。`
          : `分析已停止，已保留 ${completedSlots} 个完整时间槽。`;
        setOfflineAnalysis((current) => ({ ...current, status: 'ready', currentMetric: '', message }));
        setNotice(replacingPriorRows ? message : '离线分析已停止；未完成的时间槽没有写入。');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setOfflineAnalysis((current) => ({ ...current, status: 'error', currentMetric: '', message }));
        setNotice(replacingPriorRows
          ? `离线分析失败，旧的 ${priorRows.length} 条结果已保留：${message}`
          : `离线分析失败：${message}`);
      }
    } finally {
      setActiveOCRKey(null);
      offlineCancelRef.current = false;
    }
  };

  const toggleMonitoring = () => {
    if (mode === 'idle') {
      setNotice('请先连接摄像头、导入视频或启动演示模式。');
      return;
    }
    if (mode === 'video') {
      setNotice('离线视频请使用“开始离线分析”，不会启用墙上时间调度器。');
      return;
    }
    if (monitoring) {
      setMonitoring(false);
      setNotice('自动记录已暂停；监护仪原生报警不受影响。');
      return;
    }
    if (!session.startedAt) {
      setSession((current) => ({ ...current, startedAt: new Date().toISOString() }));
    }
    setMonitoring(true);
    setNotice('自动记录已开始。第一行立即写入，后续按固定时间槽生成。');
  };

  const captureNow = () => {
    if (mode === 'idle') {
      setNotice('当前没有视频源，无法立即记录。');
      return;
    }
    const recordedAt = new Date().toISOString();
    const row = createSnapshot(
      freshReadings(readingsRef.current, recordedAt, mode, pageVisible),
      'manual',
      recordedAt,
      recordedAt,
      { inputSource: mode },
    );
    appendSnapshots([row]);
    setNotice('已写入一条“立即记录”。');
  };

  const resetSession = () => {
    const confirmed = window.confirm('将清空当前病例、心率记录、用药事件和修订轨迹；本院药物名称目录会保留。请先导出需要保留的数据。是否继续？');
    if (!confirmed) return;
    setMonitoring(false);
    offlineCancelRef.current = true;
    camera.stop();
    videoFile.clear();
    setMode('idle');
    setMediaAspectRatio(16 / 9);
    setOfflineAnalysis(EMPTY_OFFLINE_ANALYSIS);
    setVideoCompatibilityWarning('');
    clearReferenceDataset();
    clearPersistedSession();
    const previousMedicationState = normalizeMedicationState(sessionRef.current.medications);
    const next = makeSession();
    next.medications = {
      ...createEmptyMedicationState(),
      catalog: previousMedicationState.catalog,
    };
    setSession(next);
    setReadings(emptyReadingMap());
    setHistory(makeHistory());
    consensusRef.current = makeHistory();
    heartRateStabilizationRef.current = createHeartRateStabilizationState();
    setNotice('已创建新病例。');
  };

  const updateSnapshot = (id: string, updater: (snapshot: RecordSnapshot) => RecordSnapshot) => {
    setSession((current) => ({
      ...current,
      snapshots: current.snapshots.map((snapshot) => (snapshot.id === id ? updater(snapshot) : snapshot)),
    }));
  };

  const submitCorrection = (value: string, reason: string): string | null => {
    if (!correctionTarget) return '修订目标已失效。';
    const parsed = correctionTarget.key === 'hr'
      ? parseManualHeartRateInput(value)
      : parseVitalText(correctionTarget.key, value);
    if (!parsed || !valuesWithinCaptureRange(correctionTarget.key, parsed.values)) {
      return correctionTarget.key === 'hr'
        ? '请输入 0–200 之间的纯整数心率，不要包含单位、符号或前导零。'
        : `请输入可解析的 ${VITAL_BY_KEY[correctionTarget.key].label} 数值。`;
    }
    updateSnapshot(correctionTarget.snapshotId, (snapshot) => {
      const oldReading = snapshot.readings[correctionTarget.key];
      const next = {
        ...snapshot,
        readings: {
          ...snapshot.readings,
          [correctionTarget.key]: {
            ...oldReading,
            display: parsed.display,
            values: parsed.values,
            status: 'manual-corrected' as const,
            reason: `人工修订：${reason.trim()}`,
          },
        },
        audit: [
          ...snapshot.audit,
          {
            id: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
            metric: correctionTarget.key,
            oldValue: oldReading.display,
            newValue: parsed.display,
            reason: reason.trim(),
            changedAt: new Date().toISOString(),
          },
        ],
      };
      return { ...next, quality: calculateSnapshotQuality(next.readings) };
    });
    setCorrectionTarget(null);
    setNotice('修订已保存，原始 OCR 文本与变更原因已保留。');
    return null;
  };

  const exportCSV = async () => {
    const result = await saveOrShareText(
      buildCSV(session.metadata, session.snapshots),
      `${safeFilenamePart(session.metadata.caseId || session.metadata.patientName)}_心率记录.csv`,
      'text/csv;charset=utf-8',
      platform.mobile,
    );
    if (result !== 'cancelled') setNotice(result === 'shared' ? '已打开系统分享面板。' : 'CSV 已导出。');
  };

  const exportJSON = async () => {
    const payload = {
      schemaVersion: 'petor-monitor/hr-record-export/1.0',
      exportedAt: new Date().toISOString(),
      notice: 'HR 心率辅助转录草稿，需负责兽医核对；不是监护仪原始数据。其他生命体征功能当前后置。',
      sourceVideo: videoFile.metadata
        ? {
            ...videoFile.metadata,
            localPathStored: false,
            videoStartAt: videoStartAtLocal ? new Date(videoStartAtLocal).toISOString() : null,
          }
        : null,
      session: projectSessionForExport(session),
    };
    const result = await saveOrShareText(
      JSON.stringify(payload, null, 2),
      `${safeFilenamePart(session.metadata.caseId || session.metadata.patientName)}_心率审计.json`,
      'application/json;charset=utf-8',
      platform.mobile,
    );
    if (result !== 'cancelled') setNotice(result === 'shared' ? '已打开系统分享面板。' : 'JSON 已导出。');
  };

  const exportReferenceComparisonCSV = async () => {
    if (!referenceReport) {
      setNotice('请先导入参考 CSV 并完成当前视频分析。');
      return;
    }
    const result = await saveOrShareText(
      buildHeartRateComparisonCSV(referenceReport),
      `${safeFilenamePart(videoFile.metadata?.name ?? '视频')}_HR参考对比.csv`,
      'text/csv;charset=utf-8',
      platform.mobile,
    );
    if (result !== 'cancelled') setNotice(result === 'shared' ? '已打开系统分享面板。' : 'HR 参考对比 CSV 已导出。');
  };

  const exportReferenceComparisonJSON = async () => {
    if (!referenceReport || !referenceDataset) {
      setNotice('请先导入参考 CSV 并完成当前视频分析。');
      return;
    }
    const result = await saveOrShareText(
      buildHeartRateComparisonJSON(referenceReport, referenceDataset, videoFile.metadata),
      `${safeFilenamePart(videoFile.metadata?.name ?? '视频')}_HR参考对比.json`,
      'application/json;charset=utf-8',
      platform.mobile,
    );
    if (result !== 'cancelled') setNotice(result === 'shared' ? '已打开系统分享面板。' : 'HR 参考对比 JSON 已导出。');
  };

  const exportMedicationCSV = async () => {
    const result = await saveOrShareText(
      buildMedicationCSV(session.metadata, normalizeMedicationState(session.medications)),
      `${safeFilenamePart(session.metadata.caseId || session.metadata.patientName)}_联合用药记录.csv`,
      'text/csv;charset=utf-8',
      platform.mobile,
    );
    if (result !== 'cancelled') setNotice(result === 'shared' ? '已打开系统分享面板。' : '联合用药 CSV 已导出。');
  };

  const exportMedicationAuditCSV = async () => {
    const result = await saveOrShareText(
      buildMedicationAuditCSV(normalizeMedicationState(session.medications)),
      `${safeFilenamePart(session.metadata.caseId || session.metadata.patientName)}_用药审计轨迹.csv`,
      'text/csv;charset=utf-8',
      platform.mobile,
    );
    if (result !== 'cancelled') setNotice(result === 'shared' ? '已打开系统分享面板。' : '用药审计 CSV 已导出。');
  };

  const exportMedicationJSON = async () => {
    const result = await saveOrShareText(
      buildMedicationJSON(session.metadata, normalizeMedicationState(session.medications)),
      `${safeFilenamePart(session.metadata.caseId || session.metadata.patientName)}_联合用药审计.json`,
      'application/json;charset=utf-8',
      platform.mobile,
    );
    if (result !== 'cancelled') setNotice(result === 'shared' ? '已打开系统分享面板。' : '用药 JSON 已导出。');
  };

  const installOnDevice = async () => {
    if (installPrompt.installed) {
      setNotice('PetOR 已作为 Web 应用运行。');
      return;
    }
    const outcome = await installPrompt.install();
    if (outcome === 'accepted') setNotice('安装请求已接受，可从桌面或主屏幕打开。');
    else if (outcome === 'manual') setNotice(manualInstallInstructions(platform.kind));
  };

  const reliableCount = ACTIVE_VITAL_KEYS.filter((key) => (
    key === 'hr'
      ? isAcceptedHeartRateReading(readings[key])
      : readings[key].status === 'ok' || readings[key].status === 'manual-corrected'
  )).length;
  const ocrLabel =
    mode === 'demo'
      ? '模拟数据 · 不验证 OCR'
      : mode === 'video'
        ? activeOCRKey
          ? `离线识别 ${VITAL_BY_KEY[activeOCRKey].shortLabel} · ${offlineAnalysis.completedUnits}/${offlineAnalysis.totalUnits}`
          : offlineAnalysis.message || (videoFile.status === 'loading' ? '正在读取视频' : '等待导入视频')
      : activeOCRKey
        ? `识别 ${VITAL_BY_KEY[activeOCRKey].shortLabel} · ${Math.round(ocrProgress.progress * 100)}%`
        : ocrProgress.status;

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="PetOR Monitor 首页">
          <BrandMark />
          <span><strong>PetOR</strong> Monitor</span>
        </a>
        <div className="topbar-center">
          <span className={`session-beacon ${monitoring || offlineAnalysis.status === 'running' ? 'is-recording' : ''}`} />
          {offlineAnalysis.status === 'running' ? '本地视频分析中' : monitoring ? '辅助记录中' : '辅助记录已暂停'}
        </div>
        <div className="topbar-actions">
          <button type="button" className="button subtle install-button" onClick={() => void installOnDevice()}>
            {installPrompt.installed ? '已安装' : installPrompt.promptAvailable ? '安装应用' : '安装说明'}
          </button>
          <button type="button" className="button subtle" onClick={resetSession}>+新病例</button>
        </div>
      </header>

      <main id="top">
        <aside className="safety-strip">
          <span aria-hidden="true">!</span>
          <p><strong>仅用于 HR 心率辅助转录和人工用药记录。</strong> 不替代监护仪原生报警、专责麻醉人员或临床判断；不计算剂量、不提供用药建议。</p>
        </aside>

        <aside className="scope-strip" role="note">
          <strong>当前版本范围：HR 心率</strong>
          <span>SpO₂、PR、NIBP、RR、EtCO₂、FiCO₂、TEMP 等 {DEFERRED_VITAL_KEYS.length} 项功能后置，本版本不会运行或导出这些字段的 OCR。</span>
        </aside>

        <aside className="platform-strip" aria-label="当前平台兼容状态">
          <div>
            <strong>{platform.label} Web</strong>
            <span>{platform.standalone || installPrompt.installed ? '已作为应用运行' : '浏览器模式'} · 同一前端，移动端需保持前台</span>
          </div>
          <ul>
            <li className={platform.secureContext && platform.camera ? 'is-supported' : 'is-warning'}>
              {platform.secureContext && platform.camera ? '摄像头可用' : '摄像头需要 HTTPS'}
            </li>
            <li className={platform.mp4Playback ? 'is-supported' : 'is-warning'}>{platform.mp4Playback ? 'H.264 MP4 可尝试' : '需实测视频编码'}</li>
            <li className={speech.voiceStatus === 'ready' ? 'is-supported' : 'is-warning'}>
              {speech.voiceStatus === 'ready' ? '已找到简体中文声音' : speech.voiceStatus === 'loading' ? '正在加载中文声音' : '无简体中文声音'}
            </li>
            <li className={wakeLock.status === 'active' ? 'is-supported' : wakeLock.status === 'blocked' ? 'is-warning' : ''}>
              {wakeLock.status === 'active' ? '屏幕常亮中' : wakeLock.status === 'blocked' ? '常亮失败 · 请关自动锁屏' : wakeLock.supported ? '记录时申请常亮' : '请关闭自动锁屏'}
            </li>
          </ul>
        </aside>

        {persistenceWarning && (
          <aside className="interrupt-strip storage-warning" role="alert">
            {persistenceWarning}
          </aside>
        )}

        {!pageVisible && (
          <aside className="interrupt-strip" role="alert">
            页面已进入后台：自动记录已暂停，摄像头/OCR 可能被浏览器中断；错过的时间槽记为缺失，不会回填旧值。
          </aside>
        )}

        <section className="case-section section-card">
          <div className="section-heading compact">
            <div>
              <span className="eyebrow">CASE CONTEXT</span>
              <h1>{session.metadata.patientName || '新建手术病例'}</h1>
            </div>
            <div className="case-summary">
              <span>{session.metadata.caseId || '未填病例号'}</span>
              <span>{session.metadata.procedure || '未填手术名称'}</span>
              <span>{persistenceWarning ? '草稿未保存' : '本机草稿 · 离开前必须导出'}</span>
            </div>
          </div>
          <CaseSetup metadata={session.metadata} onChange={(metadata) => setSession((current) => ({ ...current, metadata }))} />
        </section>

        <section className="capture-layout">
          <div>
            <MonitorStage
              mode={mode}
              videoRef={videoRef}
              demoCanvasRef={demoCanvasRef}
              readings={readings}
              rois={session.rois}
              selectedROI={selectedROI}
              cameraStatus={camera.status}
              ocrLabel={ocrLabel}
              videoSourceUrl={videoFile.sourceUrl}
              mediaAspectRatio={mediaAspectRatio}
              analysisLocked={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'}
              onVideoReady={handleVideoReady}
              onVideoError={(video) => modeRef.current === 'video' && videoFile.markError(video)}
              onSelectROI={setSelectedROI}
              onROIChange={(key, roi) => setSession((current) => ({ ...current, rois: { ...current.rois, [key]: roi } }))}
            />
            {mode === 'camera' && camera.error && <p className="camera-error" role="alert">{camera.error}</p>}
            {mode === 'video' && videoFile.error && <p className="camera-error" role="alert">视频无法读取：{videoFile.error}</p>}
            {mode === 'video' && videoCompatibilityWarning && <p className="compatibility-warning" role="status">{videoCompatibilityWarning}</p>}
          </div>

          <aside className="control-panel section-card">
            <div className="control-step">
              <span className="step-number">01</span>
              <div>
                <h2>选择画面</h2>
                <p>手机请优先使用后置镜头，并用支架固定。</p>
              </div>
            </div>
            <div className="segmented-actions">
              <button type="button" disabled={camera.status === 'requesting' || offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'} className={`source-button ${mode === 'camera' ? 'is-active' : ''}`} aria-pressed={mode === 'camera'} onClick={() => void startCamera()}>
                <span aria-hidden="true">◉</span><strong>摄像头</strong><small>{camera.status === 'live' ? '已连接' : camera.status === 'requesting' ? '等待授权' : '请求权限'}</small>
              </button>
              <button
                type="button"
                disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'}
                className={`source-button ${mode === 'video' ? 'is-active' : ''}`}
                aria-pressed={mode === 'video'}
                onClick={() => fileInputRef.current?.click()}
              >
                <span aria-hidden="true">▸</span><strong>导入视频</strong><small>{mode === 'video' ? '本机分析' : 'MP4 / MOV'}</small>
              </button>
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept="video/mp4,video/quicktime,video/x-m4v,video/webm,video/*"
                aria-label="选择本地监护仪视频"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) selectVideoFile(file);
                  event.currentTarget.value = '';
                }}
              />
              <input
                ref={referenceInputRef}
                className="visually-hidden"
                type="file"
                accept=".csv,text/csv"
                aria-label="选择 HR 参考 CSV"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) void selectReferenceFile(file);
                  event.currentTarget.value = '';
                }}
              />
              <button type="button" disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'} className={`source-button ${mode === 'demo' ? 'is-active' : ''}`} aria-pressed={mode === 'demo'} onClick={startDemo}>
                <span aria-hidden="true">◈</span><strong>演示模式</strong><small>无需设备</small>
              </button>
            </div>
            {mode === 'video' && videoFile.metadata && (
              <div className={`video-file-card is-${videoFile.status}`}>
                <div><strong>{videoFile.metadata.name}</strong><span>仅本机读取，不上传</span></div>
                <dl>
                  <div><dt>时长</dt><dd>{videoFile.metadata.durationSeconds > 0 ? formatMediaTime(videoFile.metadata.durationSeconds) : '读取中'}</dd></div>
                  <div><dt>画面</dt><dd>{videoFile.metadata.width > 0 ? `${videoFile.metadata.width} × ${videoFile.metadata.height}` : '读取中'}</dd></div>
                  <div><dt>大小</dt><dd>{(videoFile.metadata.sizeBytes / 1024 / 1024).toFixed(1)} MB</dd></div>
                </dl>
              </div>
            )}
            {camera.devices.length > 1 && mode === 'camera' && (
              <label className="select-field">
                <span>摄像头</span>
                <select value={camera.selectedDeviceId} onChange={(event) => void camera.selectDevice(event.target.value)}>
                  {camera.devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `摄像头 ${index + 1}`}</option>)}
                </select>
              </label>
            )}
            {mode === 'camera' && camera.activeSettings && (
              <p className="camera-settings">
                当前画面：{camera.activeSettings.width ?? '—'} × {camera.activeSettings.height ?? '—'}
                {camera.activeSettings.facingMode ? ` · ${camera.activeSettings.facingMode === 'environment' ? '后置镜头' : camera.activeSettings.facingMode}` : ''}
              </p>
            )}

            <div className="control-divider" />
            <div className="control-step">
              <span className="step-number">02</span>
              <div>
                <h2>校准识别区域</h2>
                <p>当前只校准 HR 心率框；仅接受 0–200 bpm 的唯一整数。大跳变首次只保留候选，下一连续读数在 ±2 bpm 内才建立新基线；不平滑、不平均、不回填。</p>
              </div>
            </div>
            <div className="roi-list">
              {ACTIVE_VITAL_DEFINITIONS.map(({ key, shortLabel, label, color }) => (
                <button type="button" disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'} key={key} className={selectedROI === key ? 'is-active' : ''} aria-pressed={selectedROI === key} onClick={() => setSelectedROI(selectedROI === key ? null : key)}>
                  <span className="metric-dot" style={{ backgroundColor: color }} />
                  <strong>{shortLabel}</strong><small>{label}</small><b>重画</b>
                </button>
              ))}
            </div>
            {mode === 'video' ? (
              <div className="profile-actions" aria-label="预设 ROI 布局">
                <button
                  type="button"
                  className="text-button"
                  disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'}
                  onClick={() => {
                    setSession((current) => ({ ...current, rois: { ...MINDRAY_IMEC8_VIDEO_ROIS } }));
                    setNotice('已应用 6 分钟附件视频布局，请检查 HR ROI。');
                  }}
                >6 分钟样本 HR 布局</button>
                <button
                  type="button"
                  className="text-button"
                  disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'}
                  onClick={() => {
                    setSession((current) => ({ ...current, rois: { ...MINDRAY_IMEC8_REFERENCE_VIDEO_ROIS } }));
                    setNotice('已应用 10:02 参考视频布局，请检查末段机位移动后的 ROI。');
                  }}
                >10:02 参考视频 HR 布局</button>
              </div>
            ) : (
              <button
                type="button"
                className="text-button"
                disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'}
                onClick={() => setSession((current) => ({ ...current, rois: { ...DEFAULT_ROIS } }))}
              >恢复演示布局</button>
            )}

            <div className="control-divider" />
            <div className="control-step">
              <span className="step-number">03</span>
              <div>
                <h2>{mode === 'video' ? '离线分析' : '开始记录'}</h2>
                <p>{mode === 'video'
                  ? offlinePlan.mode === 'hr-per-second'
                    ? '按视频媒体时间逐秒抽取 HR 三帧共识，不使用墙上时间。'
                    : '按视频媒体时间抽取 HR 五帧共识，不使用墙上时间。'
                  : '固定时间槽，暂停或断流后不会沿用旧值。'}</p>
              </div>
            </div>
            {mode === 'video' ? (
              <div className="offline-analysis-panel">
                <div className="record-settings">
                  <label>
                    <span>视频记录间隔</span>
                    <select
                      value={offlineIntervalSeconds}
                      disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'}
                      onChange={(event) => setOfflineIntervalSeconds(Number(event.target.value))}
                    >
                      <option value="300">5 分钟（HR 标准记录）</option>
                      <option value="60">1 分钟（HR 算法测试）</option>
                      <option value="30">30 秒（HR 参考对比，较慢）</option>
                      <option value="1">1 秒（HR 逐秒对比，耗时）</option>
                    </select>
                  </label>
                  <label>
                    <span>视频第 0 秒时间（可选）</span>
                    <input
                      type="datetime-local"
                      value={videoStartAtLocal}
                      disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'}
                      onChange={(event) => setVideoStartAtLocal(event.target.value)}
                    />
                    <small>留空时只以视频偏移时间为准。</small>
                  </label>
                </div>
                {offlinePlan.mode === 'hr-per-second' && (
                  <p className="analysis-mode-note" role="note">
                    逐秒模式只分析 HR，每槽取 3 帧共识；其他 7 项保持“未配置”。10:02 视频将生成 603 槽、约 1,809 次本地 OCR。请接电并保持页面前台，可随时停止且只保留完整槽。
                  </p>
                )}
                <div className="analysis-progress" aria-live="polite">
                  <div>
                    <strong>{offlineAnalysis.totalSlots > 0 ? `${offlineAnalysis.completedSlots}/${offlineAnalysis.totalSlots} 时间槽` : '等待视频'}</strong>
                    <span>{offlineAnalysis.currentMetric ? `${formatMediaTime(offlineAnalysis.currentMediaTime)} · ${offlineAnalysis.currentMetric}` : offlineAnalysis.message}</span>
                  </div>
                  <progress value={offlineAnalysis.completedUnits} max={Math.max(1, offlineAnalysis.totalUnits)} />
                  <small>{offlineAnalysis.totalUnits > 0
                    ? `${Math.round(offlineAnalysis.completedUnits / offlineAnalysis.totalUnits * 100)}% · ${offlinePlan.mode === 'hr-per-second' ? '每槽三帧 HR 共识' : '每槽五帧 HR 共识'}`
                    : '视频与裁剪画面不会上传'}</small>
                </div>
                {offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling' ? (
                  <button type="button" className="record-button is-stop" disabled={offlineAnalysis.status === 'cancelling'} onClick={cancelOfflineAnalysis}>
                    <span className="record-icon" />
                    {offlineAnalysis.status === 'cancelling' ? '正在停止…' : '停止离线分析'}
                  </button>
                ) : (
                  <button type="button" className="record-button" disabled={videoFile.status !== 'ready'} onClick={() => void runOfflineAnalysis()}>
                    <span className="record-icon" />
                    {offlineAnalysis.status === 'completed'
                      ? offlinePlan.mode === 'hr-per-second' ? '重新逐秒分析' : '重新分析视频'
                      : offlinePlan.mode === 'hr-per-second' ? '开始逐秒 HR 分析' : '开始离线 HR 分析'}
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="record-settings">
                  <label>
                    <span>留档间隔</span>
                    <select
                      value={session.recordIntervalMinutes}
                      disabled={session.startedAt !== null}
                      onChange={(event) => setSession((current) => ({ ...current, recordIntervalMinutes: Number(event.target.value) }))}
                    >
                      <option value="5">5 分钟（默认）</option>
                      <option value="1">1 分钟</option>
                      {mode === 'demo' && <option value={1 / 6}>10 秒（验收演练）</option>}
                    </select>
                  </label>
                  <label className="switch-row">
                    <span>
                      <strong>记录后播报</strong>
                      <small>{speechEnabled ? '已启用简体中文' : speech.playbackStatus === 'end' ? '测试通过，可手动开启' : '请先点击“测试播报”'}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={speechEnabled}
                      disabled={speech.playbackStatus !== 'end'}
                      onChange={(event) => setSpeechEnabled(event.target.checked)}
                    />
                  </label>
                </div>
                <p className={`speech-status is-${speech.voiceStatus}`} role="status">{speech.message}</p>
                <button type="button" className={`record-button ${monitoring ? 'is-stop' : ''}`} onClick={toggleMonitoring}>
                  <span className="record-icon" />
                  {monitoring ? '暂停自动记录' : '开始自动记录'}
                </button>
                <button type="button" className="button full ghost" onClick={captureNow}>立即记录一行</button>
              </>
            )}
            <button
              type="button"
              className="button full ghost"
              disabled={speech.voiceStatus !== 'ready' || speech.playbackStatus === 'speaking' || reliableCount === 0}
              onClick={() => void announce(snapshotSpeech(readingsRef.current))}
            >
              播报当前可靠读数
            </button>
          </aside>
        </section>

        <section className="live-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">LIVE HEART RATE</span>
              <h2>当前心率</h2>
            </div>
            <div className="live-summary">
              <span><b>{reliableCount}</b> / {ACTIVE_VITAL_KEYS.length} 项可记录</span>
              <span className="next-record"><small>{mode === 'video' ? '视频分析' : '下次时间槽'}</small><strong>{mode === 'video' ? `${offlineAnalysis.completedSlots}/${offlineAnalysis.totalSlots || '—'}` : formatCountdown(nextRecordIn)}</strong></span>
            </div>
          </div>
          <VitalGrid readings={readings} history={history} onCalibrate={setSelectedROI} />
        </section>

        {mode === 'video' && (
          <ReferenceComparisonPanel
            dataset={referenceDataset}
            report={referenceReport}
            error={referenceError}
            disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'}
            videoDurationSeconds={videoFile.metadata?.durationSeconds ?? null}
            alignmentOffsetSeconds={referenceOffsetSeconds}
            alignmentToleranceSeconds={referenceToleranceSeconds}
            onChooseFile={() => referenceInputRef.current?.click()}
            onClear={clearReferenceDataset}
            onOffsetChange={(value) => setReferenceOffsetSeconds(Number.isFinite(value) ? value : 0)}
            onToleranceChange={(value) => setReferenceToleranceSeconds(Number.isFinite(value) && value > 0 ? value : 0.5)}
            onExportCSV={() => void exportReferenceComparisonCSV()}
            onExportJSON={() => void exportReferenceComparisonJSON()}
          />
        )}

        <MedicationPanel
          value={normalizeMedicationState(session.medications)}
          onChange={(medications) => setSession((current) => ({ ...current, medications }))}
          disabled={offlineAnalysis.status === 'running' || offlineAnalysis.status === 'cancelling'}
          onExportCSV={() => void exportMedicationCSV()}
          onExportJSON={() => void exportMedicationJSON()}
          onExportAuditCSV={() => void exportMedicationAuditCSV()}
        />

        <section className="records-section section-card">
          <div className="section-heading records-heading">
            <div>
              <span className="eyebrow">HEART RATE RECORD · DRAFT</span>
              <h2>心率记录</h2>
              <p>保留 HR 识别状态和置信度；点击心率可人工修订并留痕。</p>
            </div>
            <div className="export-actions">
              <button
                type="button"
                className="button ghost"
                onClick={() => void testChineseSpeech()}
                disabled={speech.voiceStatus !== 'ready' || speech.playbackStatus === 'speaking'}
              >
                {speech.playbackStatus === 'speaking' ? '正在播报…' : '测试播报'}
              </button>
              <button type="button" className="button ghost" onClick={() => void exportJSON()} disabled={session.snapshots.length === 0}>JSON</button>
              <button type="button" className="button primary" onClick={() => void exportCSV()} disabled={session.snapshots.length === 0}>{platform.mobile && platform.fileShare ? '分享 CSV' : '导出 CSV'}</button>
            </div>
          </div>
          <RecordTable
            snapshots={session.snapshots}
            onToggleVerified={(id) => updateSnapshot(id, (snapshot) => ({ ...snapshot, verified: !snapshot.verified }))}
            onNoteChange={(id, note) => updateSnapshot(id, (snapshot) => ({ ...snapshot, note }))}
            onCorrect={(snapshotId, key) => {
              const snapshot = session.snapshots.find((item) => item.id === snapshotId);
              setCorrectionTarget({ snapshotId, key, currentValue: snapshot?.readings[key].display ?? null });
            }}
          />
          <footer className="record-footer">
            <span>本表为辅助转录草稿 · 已核对 {session.snapshots.filter((snapshot) => snapshot.verified).length}/{session.snapshots.length}</span>
            <span>数据模型 v2 · 识别图像不上传</span>
          </footer>
        </section>

        <section className="validation-note">
          <div>
            <span className="eyebrow">VALIDATION GATE</span>
            <h2>当前仅验收 HR 心率流程，不可验收临床识别率</h2>
          </div>
          <p>当前支持 HR 本地 OCR、固定时间槽、跳变连续确认、简体中文播报、人工修订、参考 CSV 对比和人工联合用药审计。其他生命体征后置；旧算法 filtered_value 不是人工真值，临床准确率仍需独立逐帧标注。</p>
        </section>
      </main>

      {notice && <div className="toast" role="status">{notice}</div>}
      <CorrectionDialog target={correctionTarget} onClose={() => setCorrectionTarget(null)} onSubmit={submitCorrection} />
    </div>
  );
}

export default App;
