import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSimplifiedMandarinVoice,
  selectSimplifiedMandarinVoice,
  useSpeechReadiness,
} from './useSpeechReadiness';

class MockUtterance {
  lang = '';
  rate = 1;
  pitch = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: ((event: SpeechSynthesisEvent) => unknown) | null = null;
  onerror: ((event: SpeechSynthesisErrorEvent) => unknown) | null = null;

  constructor(public text: string) {}
}

function voice(lang: string, name = lang, extra: Partial<SpeechSynthesisVoice> = {}): SpeechSynthesisVoice {
  return {
    default: false,
    lang,
    localService: true,
    name,
    voiceURI: `${lang}:${name}`,
    ...extra,
  };
}

function installSpeechRuntime(initialVoices: SpeechSynthesisVoice[]) {
  let voices = initialVoices;
  const listeners = new Set<EventListener>();
  const synthesis = {
    cancel: vi.fn(),
    speak: vi.fn(),
    getVoices: vi.fn(() => voices),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === 'voiceschanged') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (type === 'voiceschanged') listeners.delete(listener);
    }),
  } as unknown as SpeechSynthesis;

  Object.defineProperty(window, 'speechSynthesis', { value: synthesis, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: MockUtterance,
    configurable: true,
  });

  return {
    synthesis,
    setVoices(nextVoices: SpeechSynthesisVoice[]) {
      voices = nextVoices;
    },
    dispatchVoicesChanged() {
      const event = new Event('voiceschanged');
      for (const listener of listeners) listener(event);
    },
  };
}

describe('simplified Chinese speech readiness', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true });
  });

  it('recognizes zh-CN, zh-Hans, generic zh Mandarin and rejects traditional or Cantonese voices', () => {
    expect(isSimplifiedMandarinVoice(voice('zh-CN', 'Microsoft Xiaoxiao'))).toBe(true);
    expect(isSimplifiedMandarinVoice(voice('zh-Hans-CN', '简体中文'))).toBe(true);
    expect(isSimplifiedMandarinVoice(voice('zh', '中文普通话'))).toBe(true);
    expect(isSimplifiedMandarinVoice(voice('en-US', 'Chinese Mandarin'))).toBe(true);
    expect(isSimplifiedMandarinVoice(voice('zh-TW', '國語'))).toBe(false);
    expect(isSimplifiedMandarinVoice(voice('zh-HK', 'Cantonese'))).toBe(false);

    const preferred = voice('zh-CN', '中国大陆');
    expect(selectSimplifiedMandarinVoice([voice('zh', '普通话'), preferred])).toBe(preferred);
  });

  it('moves from loading to ready when voiceschanged supplies a Mandarin voice', () => {
    const runtime = installSpeechRuntime([]);
    const { result, unmount } = renderHook(() => useSpeechReadiness());

    expect(result.current).toMatchObject({
      voiceStatus: 'loading',
      playbackStatus: 'idle',
      ready: false,
    });
    expect(result.current.message).toContain('正在加载简体中文语音');

    const mandarin = voice('zh-Hans-CN', '普通话');
    act(() => {
      runtime.setVoices([voice('zh-TW', '繁體中文'), mandarin]);
      runtime.dispatchVoicesChanged();
    });

    expect(result.current).toMatchObject({
      voiceStatus: 'ready',
      playbackStatus: 'idle',
      ready: true,
      voice: mandarin,
      error: '',
    });
    expect(result.current.message).toBe('简体中文语音已就绪。');

    unmount();
    expect(runtime.synthesis.removeEventListener).toHaveBeenCalledWith('voiceschanged', expect.any(Function));
  });

  it('reports speaking then end so automatic announcements can check ready', async () => {
    const mandarin = voice('zh-CN', '普通话');
    const runtime = installSpeechRuntime([mandarin]);
    const { result } = renderHook(() => useSpeechReadiness());
    let testResult!: ReturnType<typeof result.current.testSpeech>;

    act(() => {
      testResult = result.current.testSpeech('这是测试播报。');
    });

    expect(result.current).toMatchObject({ playbackStatus: 'speaking', ready: false });
    const utterance = vi.mocked(runtime.synthesis.speak).mock.calls[0][0] as unknown as MockUtterance;
    expect(utterance).toMatchObject({
      text: '这是测试播报。',
      lang: 'zh-CN',
      rate: 0.95,
      pitch: 1,
      voice: mandarin,
    });

    await act(async () => {
      utterance.onend?.({ utterance: utterance as unknown as SpeechSynthesisUtterance } as SpeechSynthesisEvent);
      await testResult;
    });

    await expect(testResult).resolves.toEqual({ outcome: 'end' });
    expect(result.current).toMatchObject({ playbackStatus: 'end', ready: true, error: '' });
    expect(result.current.message).toContain('测试播报已完成');

    act(() => runtime.dispatchVoicesChanged());
    expect(result.current).toMatchObject({ playbackStatus: 'end', ready: true });
  });

  it('retains a Chinese visual fallback after a speech error', async () => {
    const runtime = installSpeechRuntime([voice('zh', '普通话')]);
    const { result } = renderHook(() => useSpeechReadiness());
    let testResult!: ReturnType<typeof result.current.testSpeech>;

    act(() => {
      testResult = result.current.testSpeech();
    });
    const utterance = vi.mocked(runtime.synthesis.speak).mock.calls[0][0] as unknown as MockUtterance;

    await act(async () => {
      utterance.onerror?.({ error: 'not-allowed' } as SpeechSynthesisErrorEvent);
      await testResult;
    });

    await expect(testResult).resolves.toMatchObject({ outcome: 'error', code: 'not-allowed' });
    expect(result.current.ready).toBe(false);
    expect(result.current.playbackStatus).toBe('error');
    expect(result.current.error).toContain('浏览器未允许语音播放');
    expect(result.current.message).toContain('请以页面视觉记录为准');
  });

  it('fails visibly instead of hanging when the speech engine never responds', async () => {
    vi.useFakeTimers();
    try {
      installSpeechRuntime([voice('zh-CN', '普通话')]);
      const { result } = renderHook(() => useSpeechReadiness());
      let testResult!: ReturnType<typeof result.current.testSpeech>;

      act(() => {
        testResult = result.current.testSpeech();
        vi.advanceTimersByTime(15_000);
      });

      await expect(testResult).resolves.toMatchObject({ outcome: 'error', code: 'timeout' });
      expect(result.current.message).toContain('长时间未响应');
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes an unsupported state without throwing', async () => {
    const { result } = renderHook(() => useSpeechReadiness());

    expect(result.current).toMatchObject({
      voiceStatus: 'unsupported',
      playbackStatus: 'idle',
      ready: false,
    });
    expect(result.current.message).toContain('不支持语音播报');

    await expect(result.current.testSpeech()).resolves.toMatchObject({
      outcome: 'error',
      code: 'unsupported',
    });
  });
});
