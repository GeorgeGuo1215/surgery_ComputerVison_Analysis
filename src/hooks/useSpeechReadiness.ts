import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type SpeechVoiceStatus = 'unsupported' | 'loading' | 'unavailable' | 'ready';
export type SpeechPlaybackStatus = 'idle' | 'speaking' | 'end' | 'error';

export type SpeechTestResult =
  | { outcome: 'end' }
  | { outcome: 'error'; error: string; code: string };

interface SpeechReadinessState {
  voiceStatus: SpeechVoiceStatus;
  playbackStatus: SpeechPlaybackStatus;
  voice: SpeechSynthesisVoice | null;
  error: string;
}

export interface SpeechReadiness extends SpeechReadinessState {
  ready: boolean;
  message: string;
  refreshVoices: () => void;
  testSpeech: (text?: string) => Promise<SpeechTestResult>;
}

const DEFAULT_TEST_TEXT = '简体中文播报已就绪。';

const INITIAL_STATE: SpeechReadinessState = {
  voiceStatus: 'loading',
  playbackStatus: 'idle',
  voice: null,
  error: '',
};

function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase().replaceAll('_', '-');
}

export function isSimplifiedMandarinVoice(
  voice: Pick<SpeechSynthesisVoice, 'lang' | 'name'>,
): boolean {
  const language = normalizeLanguage(voice.lang);
  const name = voice.name.toLowerCase();
  const explicitlyTraditional =
    language === 'zh-tw' ||
    language.startsWith('zh-tw-') ||
    language === 'zh-hk' ||
    language.startsWith('zh-hk-') ||
    language === 'zh-mo' ||
    language.startsWith('zh-mo-') ||
    language.includes('hant') ||
    language === 'yue' ||
    language.startsWith('yue-') ||
    /cantonese|粤语|廣東話|广东话/i.test(name);

  if (explicitlyTraditional) return false;

  return (
    language === 'zh' ||
    language === 'zh-cn' ||
    language.startsWith('zh-cn-') ||
    language === 'zh-sg' ||
    language.startsWith('zh-sg-') ||
    language.startsWith('zh-hans') ||
    language === 'cmn' ||
    language.startsWith('cmn-') ||
    /mandarin|普通话|普通話/i.test(name)
  );
}

function voiceScore(voice: SpeechSynthesisVoice): number {
  const language = normalizeLanguage(voice.lang);
  let score = 0;
  if (language === 'zh-cn') score = 100;
  else if (language.startsWith('zh-hans')) score = 95;
  else if (language === 'cmn-cn' || language.startsWith('cmn-hans')) score = 90;
  else if (language === 'zh-sg') score = 85;
  else if (language === 'zh') score = 80;
  else if (language.startsWith('cmn')) score = 75;
  else score = 70;
  if (voice.default) score += 2;
  if (voice.localService) score += 1;
  return score;
}

export function selectSimplifiedMandarinVoice(
  voices: readonly SpeechSynthesisVoice[],
): SpeechSynthesisVoice | null {
  return [...voices]
    .filter(isSimplifiedMandarinVoice)
    .sort((left, right) => voiceScore(right) - voiceScore(left))[0] ?? null;
}

export function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
      return '浏览器未允许语音播放，请再次点击“测试播报”。';
    case 'audio-busy':
      return '音频设备正在忙，请稍后重试。';
    case 'audio-hardware':
      return '未检测到可用的音频输出设备。';
    case 'language-unavailable':
    case 'voice-unavailable':
      return '系统暂无可用的简体中文语音。';
    case 'canceled':
    case 'interrupted':
      return '语音播报已被中断。';
    case 'network':
      return '语音服务网络异常，请检查连接后重试。';
    case 'timeout':
      return '语音引擎长时间未响应，请重新点击“测试播报”。';
    default:
      return `语音引擎播报失败（${code || '未知错误'}）。`;
  }
}

export function speechReadinessMessage(state: SpeechReadinessState): string {
  if (state.playbackStatus === 'speaking') return '正在测试简体中文播报……';
  if (state.playbackStatus === 'end') return '测试播报已完成，简体中文语音可用。';
  if (state.playbackStatus === 'error') {
    return `${state.error || '简体中文播报失败。'}请以页面视觉记录为准。`;
  }
  if (state.voiceStatus === 'unsupported') {
    return '当前浏览器不支持语音播报，请以页面视觉记录为准。';
  }
  if (state.voiceStatus === 'loading') {
    return '正在加载简体中文语音，自动播报暂未启用。';
  }
  if (state.voiceStatus === 'unavailable') {
    return state.error
      ? `${state.error}请以页面视觉记录为准。`
      : '未找到简体中文普通话语音，请以页面视觉记录为准。';
  }
  return '简体中文语音已就绪。';
}

function speechSynthesisRuntime(): SpeechSynthesis | null {
  if (
    typeof window === 'undefined' ||
    !window.speechSynthesis ||
    typeof window.SpeechSynthesisUtterance !== 'function'
  ) {
    return null;
  }
  return window.speechSynthesis;
}

export function useSpeechReadiness(): SpeechReadiness {
  const [state, setState] = useState<SpeechReadinessState>(INITIAL_STATE);
  const synthesisRef = useRef<SpeechSynthesis | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const mountedRef = useRef(false);
  const playbackRunRef = useRef(0);

  const refreshVoices = useCallback(() => {
    const synthesis = speechSynthesisRuntime();
    synthesisRef.current = synthesis;
    if (!synthesis) {
      voiceRef.current = null;
      setState({
        voiceStatus: 'unsupported',
        playbackStatus: 'idle',
        voice: null,
        error: '',
      });
      return;
    }

    try {
      const voices = synthesis.getVoices();
      const voice = selectSimplifiedMandarinVoice(voices);
      voiceRef.current = voice;
      setState((current) => ({
        voiceStatus: voice ? 'ready' : voices.length === 0 ? 'loading' : 'unavailable',
        playbackStatus: current.playbackStatus,
        voice,
        error: current.playbackStatus === 'error' ? current.error : '',
      }));
    } catch (error) {
      voiceRef.current = null;
      const detail = error instanceof Error ? error.message : String(error);
      setState({
        voiceStatus: 'unavailable',
        playbackStatus: 'idle',
        voice: null,
        error: `无法读取系统语音列表：${detail}。`,
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const synthesis = speechSynthesisRuntime();
    synthesisRef.current = synthesis;
    refreshVoices();
    if (!synthesis) {
      return () => {
        mountedRef.current = false;
        playbackRunRef.current += 1;
      };
    }

    synthesis.addEventListener('voiceschanged', refreshVoices);
    const retryTimers = [250, 1_000, 3_000].map((delay) => window.setTimeout(refreshVoices, delay));
    return () => {
      mountedRef.current = false;
      playbackRunRef.current += 1;
      retryTimers.forEach((timer) => window.clearTimeout(timer));
      synthesis.removeEventListener('voiceschanged', refreshVoices);
    };
  }, [refreshVoices]);

  const testSpeech = useCallback((text = DEFAULT_TEST_TEXT): Promise<SpeechTestResult> => {
    const synthesis = synthesisRef.current ?? speechSynthesisRuntime();
    const voice = voiceRef.current;
    if (!synthesis || !voice) {
      const error = synthesis
        ? '未找到简体中文普通话语音。'
        : '当前浏览器不支持语音播报。';
      if (mountedRef.current) {
        setState((current) => ({ ...current, playbackStatus: 'error', error }));
      }
      return Promise.resolve({ outcome: 'error', error, code: synthesis ? 'voice-unavailable' : 'unsupported' });
    }

    const runId = playbackRunRef.current + 1;
    playbackRunRef.current = runId;
    synthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.rate = 0.95;
    utterance.pitch = 1;
    utterance.voice = voice;
    setState((current) => ({ ...current, playbackStatus: 'speaking', error: '' }));

    return new Promise<SpeechTestResult>((resolve) => {
      let settled = false;
      let timeout = 0;
      const finish = (result: SpeechTestResult) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (mountedRef.current && playbackRunRef.current === runId) {
          setState((current) => ({
            ...current,
            playbackStatus: result.outcome,
            error: result.outcome === 'error' ? result.error : '',
          }));
        }
        resolve(result);
      };

      utterance.onend = () => finish({ outcome: 'end' });
      utterance.onerror = (event) => {
        const code = event.error || 'unknown';
        finish({ outcome: 'error', error: speechErrorMessage(code), code });
      };
      timeout = window.setTimeout(() => finish({
        outcome: 'error',
        error: speechErrorMessage('timeout'),
        code: 'timeout',
      }), 15_000);

      try {
        synthesis.speak(utterance);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        finish({
          outcome: 'error',
          error: `无法启动语音播报：${detail}。`,
          code: 'speak-threw',
        });
      }
    });
  }, []);

  const ready = state.voiceStatus === 'ready' && (
    state.playbackStatus === 'idle' || state.playbackStatus === 'end'
  );
  const message = useMemo(() => speechReadinessMessage(state), [state]);

  return { ...state, ready, message, refreshVoices, testSpeech };
}
