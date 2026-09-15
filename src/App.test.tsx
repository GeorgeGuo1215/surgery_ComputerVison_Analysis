import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { buildCSV } from './domain/export';
import { createSnapshot } from './domain/recording';
import { DEFAULT_ROIS, VITAL_KEYS, emptyReadingMap, formatDemoReading } from './domain/vitals';
import { BrowserOCR } from './services/ocr';

vi.mock('./services/video', () => ({
  seekVideoFrame: vi.fn(async (_video: HTMLVideoElement, requestedSeconds: number) => requestedSeconds),
}));

vi.mock('./services/ocr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/ocr')>();
  return {
    ...actual,
    captureFrozenFrame: vi.fn(() => document.createElement('canvas')),
    cropRawForOCR: vi.fn(() => document.createElement('canvas')),
    cropAndPreprocess: vi.fn(() => { const crop = document.createElement('canvas'); crop.dataset.metric = 'rr'; return crop; }),
  };
});

const VIDEO_FILE_NAME = 'same-video.mp4';

function seedExistingVideoRecord() {
  const capturedAt = '2026-08-17T08:00:00.000Z';
  const readings = emptyReadingMap(capturedAt);
  readings.hr = formatDemoReading('hr', [118], capturedAt);
  const snapshot = createSnapshot(readings, 'scheduled', capturedAt, capturedAt, {
    inputSource: 'video',
    mediaTimeSeconds: 0,
    sourceFileName: VIDEO_FILE_NAME,
    analyzedAt: capturedAt,
    analysisRunId: 'existing-run',
  });
  snapshot.id = 'existing-video-row';
  localStorage.setItem(
    'petor-monitor/session-v1',
    JSON.stringify({
      version: 1,
      sessionId: 'video-rerun-test',
      startedAt: capturedAt,
      metadata: { caseId: 'QA-VIDEO', patientName: '演示犬', species: '犬', weight: '8 kg', procedure: '验收', clinician: 'QA' },
      rois: DEFAULT_ROIS,
      snapshots: [snapshot],
      recordIntervalMinutes: 5,
    }),
  );
}

async function importReadySameNameVideo(duration = 10) {
  const input = screen.getByLabelText('选择本地监护仪视频');
  fireEvent.change(input, {
    target: { files: [new File(['video'], VIDEO_FILE_NAME, { type: 'video/mp4' })] },
  });
  const video = await screen.findByLabelText('离线监护仪视频');
  Object.defineProperties(video, {
    duration: { value: duration, configurable: true },
    videoWidth: { value: 544, configurable: true },
    videoHeight: { value: 960, configurable: true },
  });
  fireEvent.loadedMetadata(video);
  const start = await screen.findByRole('button', { name: '开始离线 HR + RR 分析' });
  await waitFor(() => expect(start).toBeEnabled());
  return start;
}

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error));
    reader.readAsText(blob);
  });
}

describe('PetOR web workflow', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        cancel: vi.fn(),
        speak: vi.fn(),
        getVoices: () => [],
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: class { lang = ''; rate = 1; pitch = 1; voice = null; constructor(public text: string) {} },
      configurable: true,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:app-test'),
      configurable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      value: vi.fn(),
      configurable: true,
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  it('renders the safety boundary and complete workflow', () => {
    render(<App />);
    expect(screen.getByText('仅用于 HR 心率、RR 呼吸率辅助转录和人工用药记录。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /演示模式/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '心率与呼吸率记录' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始自动记录' })).toBeInTheDocument();
  });

  it('automatically downloads at five minutes with the boundary row included', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T02:00:00.000Z'));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      fillText: vi.fn(), fillRect: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    render(<App />);
    expect(screen.getByRole('checkbox', { name: /每 5 分钟自动保存 CSV/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /演示模式.*无需设备/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始自动记录' }));
    await act(async () => vi.advanceTimersByTimeAsync(299_999));
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    vi.useRealTimers();
    const csv = await readBlobText(blob);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(csv).toContain('2026-09-15T02:00:00.000Z');
    expect(csv).toContain('2026-09-15T02:05:00.000Z');
    expect(lines[0]).toContain('RR,RR候选值,RR置信度,RR状态');
    const columns = lines[0].split(',');
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      expect(Number(cells[columns.indexOf('RR')])).toBeGreaterThan(0);
      expect(cells[columns.indexOf('RR采集时间ISO_UTC')]).toBe(cells[columns.indexOf('HR采集时间ISO_UTC')]);
    }
    expect(screen.getByText(/已请求 Chrome 下载，请检查下载列表/)).toBeInTheDocument();
  });

  it('exposes HR and RR controls, current reading and record columns in the MVP UI', () => {
    render(<App />);

    expect(screen.getAllByText('HR').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /RR.*呼吸率.*重画/ })).toBeInTheDocument();
    const vitalGridText = document.querySelector('.vital-grid')?.textContent ?? '';
    const recordHeaderText = document.querySelector('.record-table thead')?.textContent ?? '';
    for (const deferredLabel of ['SpO₂', 'PR', 'NIBP', 'EtCO₂', 'FiCO₂', 'TEMP']) {
      expect(vitalGridText).not.toContain(deferredLabel);
      expect(recordHeaderText).not.toContain(deferredLabel);
      expect(screen.queryByRole('button', { name: new RegExp(`^${deferredLabel}`) })).not.toBeInTheDocument();
    }
    expect(document.querySelector('.live-summary')?.textContent).toContain('0 / 2 项可记录');
  });

  it('records a fixed slot inside a sub-30-second hidden interval as missing after the page resumes', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-08-18T02:00:00.000Z');
    vi.setSystemTime(startedAt);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      fillRect: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /演示模式.*无需设备/ }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    fireEvent.change(screen.getByLabelText('留档间隔'), {
      target: { value: String(1 / 6) },
    });
    fireEvent.click(screen.getByRole('button', { name: '开始自动记录' }));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    let stored = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!);
    expect(stored.snapshots).toHaveLength(1);
    expect(stored.snapshots[0].readings.hr).toMatchObject({ status: 'ok' });
    const preHiddenDisplay = stored.snapshots[0].readings.hr.display;
    expect(preHiddenDisplay).not.toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    // Simulate a browser that suspends timers while hidden, then resumes within 30 seconds.
    vi.setSystemTime(new Date(startedAt.getTime() + 15_000));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByRole('button', { name: '开始自动记录' })).toBeInTheDocument();
    expect(screen.getByText(/自动记录仍处于暂停/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '开始自动记录' }));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    stored = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!);
    expect(stored.snapshots).toHaveLength(2);
    const hiddenSlot = stored.snapshots[1];
    expect(hiddenSlot.scheduledAt).toBe(new Date(startedAt.getTime() + 10_000).toISOString());
    expect(Date.parse(hiddenSlot.recordedAt) - Date.parse(hiddenSlot.scheduledAt)).toBeLessThan(30_000);
    expect(hiddenSlot.readings.hr).toMatchObject({
      display: null,
      values: [],
      status: 'not-found',
      reason: expect.stringMatching(/页面后台|不回填/),
    });
    expect(hiddenSlot.readings.hr.display).not.toBe(preHiddenDisplay);
  });

  it('opens a record cell, validates the correction reason and retains an audit trail', () => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const readings = emptyReadingMap(capturedAt);
    for (const key of VITAL_KEYS) {
      const values = key === 'nibp' ? [112, 68, 82] : [key === 'temp' ? 37.6 : key === 'hr' ? 118 : 98];
      readings[key] = formatDemoReading(key, values, capturedAt);
    }
    const snapshot = createSnapshot(readings, 'scheduled', capturedAt, capturedAt);
    localStorage.setItem(
      'petor-monitor/session-v1',
      JSON.stringify({
        version: 1,
        sessionId: 'test-session',
        startedAt: capturedAt,
        metadata: { caseId: 'QA-01', patientName: '演示犬', species: '犬', weight: '8 kg', procedure: '验收', clinician: 'QA' },
        rois: DEFAULT_ROIS,
        snapshots: [snapshot],
        recordIntervalMinutes: 5,
      }),
    );

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /118 99%/ }));
    expect(screen.getByRole('dialog', { name: '心率' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/\u6b63确读数/), { target: { value: 'B250' } });
    fireEvent.change(screen.getByLabelText(/\u4fee订原因/), { target: { value: '人工核对监护仪' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并写入审计记录' }));
    expect(screen.getByRole('dialog', { name: '心率' })).toBeInTheDocument();
    expect(document.querySelector('.field-error')).toHaveTextContent(/整数|0.*200|有效/);

    fireEvent.change(screen.getByLabelText(/\u6b63确读数/), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并写入审计记录' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /123 已修订/ })).toBeInTheDocument();
  });

  it('keeps a persistent warning visible when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });

    render(<App />);

    expect(await screen.findByText(/浏览器本机存储不可用/)).toBeInTheDocument();
    expect(screen.getByText('草稿未保存')).toBeInTheDocument();
  });

  it('preserves existing same-name video rows when OCR initialization fails during a replacement run', async () => {
    seedExistingVideoRecord();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(BrowserOCR.prototype, 'initialize').mockRejectedValue(new Error('OCR 初始化失败'));

    render(<App />);
    const start = await importReadySameNameVideo();
    fireEvent.click(start);

    await waitFor(() => {
      expect(document.querySelector('.toast')).toHaveTextContent('离线分析失败，旧的 1 条结果已保留：OCR 初始化失败');
    });
    expect(screen.getByRole('button', { name: /118 99%/ })).toBeInTheDocument();
    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!);
      expect(stored.snapshots).toEqual([
        expect.objectContaining({ id: 'existing-video-row', sourceFileName: VIDEO_FILE_NAME }),
      ]);
    });
  });

  it('preserves existing same-name video rows when replacement is cancelled before its first slot', async () => {
    seedExistingVideoRecord();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishInitialization!: () => void;
    vi.spyOn(BrowserOCR.prototype, 'initialize').mockImplementation(() => new Promise<void>((resolve) => {
      finishInitialization = resolve;
    }));

    render(<App />);
    const start = await importReadySameNameVideo();
    fireEvent.click(start);
    fireEvent.click(await screen.findByRole('button', { name: '停止离线分析' }));
    await act(async () => finishInitialization());

    await waitFor(() => {
      expect(document.querySelector('.toast')).toHaveTextContent('分析已停止；旧的 1 条结果已保留，本次 0 个完整时间槽未替换旧结果。');
    });
    expect(screen.getByRole('button', { name: /118 99%/ })).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!);
    expect(stored.snapshots).toEqual([
      expect.objectContaining({ id: 'existing-video-row', sourceFileName: VIDEO_FILE_NAME }),
    ]);
  });

  it('applies cross-slot stabilization to offline 50 → 120 → 121 without averaging or forward fill', async () => {
    vi.spyOn(BrowserOCR.prototype, 'initialize').mockResolvedValue(undefined);
    const observed = [50, 50, 50, 120, 120, 120, 121, 121, 121];
    const recognize = vi.spyOn(BrowserOCR.prototype, 'recognize').mockImplementation(async (crop) => ({
      text: (crop as HTMLCanvasElement).dataset.metric === 'rr' ? '18' : String(observed.shift()),
      confidence: 99,
    }));

    render(<App />);
    await importReadySameNameVideo(2.1);
    fireEvent.change(screen.getByLabelText('视频记录间隔'), { target: { value: '1' } });
    fireEvent.click(await screen.findByRole('button', { name: '开始逐秒 HR + RR 分析' }));

    await waitFor(() => {
      expect(document.querySelector('.toast')).toHaveTextContent('离线分析完成：生成 3 行记录');
    });
    expect(recognize).toHaveBeenCalledTimes(18);
    expect(observed).toHaveLength(0);

    await waitFor(() => {
      const stored = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!);
      expect(stored.snapshots).toHaveLength(3);
    });
    const stored = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!);
    const videoRows = stored.snapshots.filter((snapshot: { sourceFileName?: string }) => (
      snapshot.sourceFileName === VIDEO_FILE_NAME
    ));

    expect(videoRows.map((snapshot: { readings: { hr: unknown }; quality: string }) => ({
      hr: snapshot.readings.hr,
      quality: snapshot.quality,
    }))).toMatchObject([
      {
        hr: { display: '50', values: [50], status: 'ok' },
        quality: 'complete',
      },
      {
        hr: { display: '120', values: [120], status: 'low-confidence', reason: expect.stringMatching(/不前填/) },
        quality: 'review',
      },
      {
        hr: { display: '121', values: [121], status: 'ok', reason: expect.stringMatching(/新基线|未取平均/) },
        quality: 'complete',
      },
    ]);
    for (const row of videoRows) {
      expect(row.readings.rr).toMatchObject({ display: '18', status: 'ok', capturedAt: row.readings.hr.capturedAt });
    }
    expect(videoRows[1].readings.hr.display).not.toBe('50');
    expect(videoRows[2].readings.hr.display).not.toBe('120.5');

    const [header, ...rows] = buildCSV(stored.metadata, videoRows).slice(1).split('\r\n');
    const headers = header.split(',');
    const cells = rows.map((row) => row.split(','));
    const reliableIndex = headers.indexOf('HR');
    const candidateIndex = headers.indexOf('HR候选值');
    expect(cells.map((row) => [row[reliableIndex], row[candidateIndex]])).toEqual([
      ['50', ''],
      ['', '120'],
      ['121', ''],
    ]);
  });

  it('applies the same jump confirmation before camera readings can be committed to rows', async () => {
    vi.useFakeTimers();
    const track = {
      addEventListener: vi.fn(),
      getSettings: vi.fn(() => ({ deviceId: 'camera-test', width: 544, height: 960, facingMode: 'environment' })),
      stop: vi.fn(),
    };
    const stream = {
      getVideoTracks: vi.fn(() => [track]),
      getTracks: vi.fn(() => [track]),
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    vi.spyOn(BrowserOCR.prototype, 'initialize').mockResolvedValue(undefined);
    const observed = [50, 50, 120, 120, 120];
    const recognize = vi.spyOn(BrowserOCR.prototype, 'recognize').mockImplementation(async (crop) => ({
      text: (crop as HTMLCanvasElement).dataset.metric === 'rr' ? '18' : String(observed.shift()),
      confidence: 99,
    }));

    render(<App />);
    const video = screen.getByLabelText('摄像头实时画面');
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA, configurable: true },
      videoWidth: { value: 544, configurable: true },
      videoHeight: { value: 960, configurable: true },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /摄像头.*请求权限/ }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const advanceToRecognitionCount = async (count: number) => {
      for (let attempt = 0; attempt < 10 && recognize.mock.calls.length < count * 2; attempt += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(attempt === 0 ? 0 : 1_200);
        });
      }
      expect(recognize).toHaveBeenCalledTimes(count * 2);
    };

    await advanceToRecognitionCount(1);
    expect(document.querySelectorAll('.vital-card')[1]).toHaveClass('status-low-confidence');
    await advanceToRecognitionCount(2);
    expect(document.querySelectorAll('.vital-card')[1]).toHaveClass('status-ok');
    await advanceToRecognitionCount(4);
    expect(document.querySelector('.vital-card')).toHaveClass('status-low-confidence');
    expect(document.querySelector('.vital-value')).toHaveTextContent('120');
    expect(document.querySelector('.vital-reason')).toHaveTextContent(/不前填|待确认/);
    fireEvent.click(screen.getByRole('button', { name: '立即记录一行' }));

    await advanceToRecognitionCount(5);
    expect(document.querySelector('.vital-card')).toHaveClass('status-ok');
    expect(document.querySelector('.vital-value')).toHaveTextContent('120');
    expect(document.querySelector('.vital-reason')).toHaveTextContent(/新基线|未取平均/);
    fireEvent.click(screen.getByRole('button', { name: '立即记录一行' }));

    await act(async () => Promise.resolve());
    const stored = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!);
    expect(stored.snapshots.map((snapshot: { readings: { hr: unknown }; quality: string }) => ({
      hr: snapshot.readings.hr,
      quality: snapshot.quality,
    }))).toMatchObject([
      { hr: { display: '120', status: 'low-confidence' }, quality: 'review' },
      { hr: { display: '120', status: 'ok' }, quality: 'complete' },
    ]);
  });

  it('does not confirm a camera jump across an intervening OCR failure', async () => {
    vi.useFakeTimers();
    const track = {
      addEventListener: vi.fn(),
      getSettings: vi.fn(() => ({ deviceId: 'camera-gap-test', width: 544, height: 960 })),
      stop: vi.fn(),
    };
    const stream = {
      getVideoTracks: vi.fn(() => [track]),
      getTracks: vi.fn(() => [track]),
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
        enumerateDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      configurable: true,
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
    const observed: Array<number | Error> = [50, 50, 120, 120, new Error('模拟 OCR 丢帧'), 120];
    const recognize = vi.spyOn(BrowserOCR.prototype, 'recognize').mockImplementation(async (crop) => {
      if ((crop as HTMLCanvasElement).dataset.metric === 'rr') return { text: '18', confidence: 99 };
      const next = observed.shift();
      if (next instanceof Error) throw next;
      return { text: String(next), confidence: 99 };
    });

    render(<App />);
    const video = screen.getByLabelText('摄像头实时画面');
    Object.defineProperties(video, {
      readyState: { value: HTMLMediaElement.HAVE_CURRENT_DATA, configurable: true },
      videoWidth: { value: 544, configurable: true },
      videoHeight: { value: 960, configurable: true },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /摄像头.*请求权限/ }));
      await Promise.resolve();
      await Promise.resolve();
    });
    const advanceToRecognitionCount = async (count: number) => {
      for (let attempt = 0; attempt < 10 && recognize.mock.calls.length < count * 2; attempt += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(attempt === 0 ? 0 : 1_200);
        });
      }
      expect(recognize).toHaveBeenCalledTimes(count * 2);
    };

    await advanceToRecognitionCount(4);
    expect(document.querySelector('.vital-card')).toHaveClass('status-low-confidence');
    await advanceToRecognitionCount(5);
    expect(document.querySelector('.ocr-status')).toHaveTextContent('OCR 不可用：模拟 OCR 丢帧');
    await advanceToRecognitionCount(6);

    expect(document.querySelector('.vital-card')).toHaveClass('status-low-confidence');
    expect(document.querySelector('.vital-value')).toHaveTextContent('120');
    expect(document.querySelector('.vital-reason')).toHaveTextContent(/待确认|不前填/);
  });

  it('creates a two-drug event from the main page and includes it in persistence and the main JSON export', async () => {
    seedExistingVideoRecord();
    const createObjectURL = vi.mocked(URL.createObjectURL);

    render(<App />);
    const catalogInput = screen.getByLabelText('自定义药物名称');
    fireEvent.change(catalogInput, { target: { value: '医院药物甲' } });
    fireEvent.click(screen.getByRole('button', { name: '加入目录' }));
    fireEvent.change(catalogInput, { target: { value: '医院药物乙' } });
    fireEvent.click(screen.getByRole('button', { name: '加入目录' }));
    fireEvent.click(screen.getByRole('button', { name: '新建联合用药记录' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '医院药物甲' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '医院药物乙' }));
    fireEvent.change(screen.getByLabelText('阶段'), { target: { value: 'induction' } });
    fireEvent.change(screen.getByLabelText('给药时间'), { target: { value: '2026-08-18T10:15' } });
    fireEvent.change(screen.getByLabelText('剂量文本 1'), { target: { value: '人员填写甲' } });
    fireEvent.change(screen.getByLabelText('单位 1'), { target: { value: '单位甲' } });
    fireEvent.change(screen.getByLabelText('途径 1'), { target: { value: '途径甲' } });
    fireEvent.change(screen.getByLabelText('剂量文本 2'), { target: { value: '人员填写乙' } });
    fireEvent.change(screen.getByLabelText('单位 2'), { target: { value: '单位乙' } });
    fireEvent.change(screen.getByLabelText('途径 2'), { target: { value: '途径乙' } });
    fireEvent.click(screen.getByRole('button', { name: '保存联合用药记录' }));

    await waitFor(() => {
      const persisted = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!);
      expect(persisted.medications.events).toHaveLength(1);
      expect(persisted.medications.events[0].medications).toHaveLength(2);
    });
    const persisted = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!);
    expect(persisted.medications.events[0]).toMatchObject({
      phase: 'induction',
      medications: [
        { name: '医院药物甲', doseText: '人员填写甲', unit: '单位甲', route: '途径甲' },
        { name: '医院药物乙', doseText: '人员填写乙', unit: '单位乙', route: '途径乙' },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const payload = JSON.parse(await readBlobText(blob));
    expect(payload.session.medications.events).toHaveLength(1);
    expect(payload.session.medications.events[0].medications).toMatchObject([
      { name: '医院药物甲', doseText: '人员填写甲', unit: '单位甲', route: '途径甲' },
      { name: '医院药物乙', doseText: '人员填写乙', unit: '单位乙', route: '途径乙' },
    ]);
    expect(payload.session.medications.audit.some((entry: { action: string }) => entry.action === 'event-created')).toBe(true);
  });

  it('allows a missing legacy RR to be manually corrected without changing HR', async () => {
    seedExistingVideoRecord();
    render(<App />);
    const rrCell = document.querySelectorAll('.record-table .table-reading')[1];
    expect(rrCell).toHaveTextContent('—');
    fireEvent.click(rrCell);
    expect(screen.getByRole('dialog', { name: '呼吸率' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/正确读数/), { target: { value: '18.5' } });
    fireEvent.change(screen.getByLabelText(/修订原因/), { target: { value: '核对呼吸率画面' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并写入审计记录' }));
    expect(screen.getByRole('dialog', { name: '呼吸率' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/正确读数/), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并写入审计记录' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const row = JSON.parse(localStorage.getItem('petor-monitor/session-v2')!).snapshots[0];
    expect(row.readings.hr.display).toBe('118');
    expect(row.readings.rr).toMatchObject({ display: '0', values: [0], status: 'manual-corrected' });
    expect(row.audit).toEqual([expect.objectContaining({ metric: 'rr', oldValue: null, newValue: '0' })]);
  });

  it('exports the versioned HR and RR JSON envelope from the App', async () => {
    seedExistingVideoRecord();
    const createObjectURL = vi.mocked(URL.createObjectURL);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'JSON' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const payload = JSON.parse(await readBlobText(blob));

    expect(payload.schemaVersion).toBe('petor-monitor/vital-record-export/2.0');
    expect(payload.session.productScope.activeVitalKeys).toEqual(['hr', 'rr']);
    expect(Object.keys(payload.session.snapshots[0].readings)).toEqual(['hr', 'rr']);
  });
});
