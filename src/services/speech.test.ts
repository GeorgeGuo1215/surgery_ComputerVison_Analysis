import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSimplifiedChineseVoice, snapshotSpeech, speak } from './speech';
import { emptyReadingMap, formatDemoReading } from '../domain/vitals';

describe('simplified Chinese speech', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: class {
        lang = '';
        rate = 1;
        pitch = 1;
        voice: SpeechSynthesisVoice | null = null;

        constructor(public text: string) {}
      },
      configurable: true,
    });
  });

  it('accepts simplified Chinese voice tags and rejects traditional Chinese tags', () => {
    expect(isSimplifiedChineseVoice({ lang: 'zh-CN' })).toBe(true);
    expect(isSimplifiedChineseVoice({ lang: 'zh-Hans-CN' })).toBe(true);
    expect(isSimplifiedChineseVoice({ lang: 'zh-SG' })).toBe(true);
    expect(isSimplifiedChineseVoice({ lang: 'zh-TW' })).toBe(false);
    expect(isSimplifiedChineseVoice({ lang: 'zh-HK' })).toBe(false);
  });

  it('sets zh-CN and never selects a traditional Chinese voice', () => {
    const simplifiedVoice = { lang: 'zh-CN' } as SpeechSynthesisVoice;
    const traditionalVoice = { lang: 'zh-TW' } as SpeechSynthesisVoice;
    const speakMock = vi.fn();
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        cancel: vi.fn(),
        speak: speakMock,
        getVoices: () => [traditionalVoice, simplifiedVoice],
      },
      configurable: true,
    });

    expect(speak('简体中文播报测试。')).toBe(true);
    const utterance = speakMock.mock.calls[0][0] as SpeechSynthesisUtterance;
    expect(utterance.lang).toBe('zh-CN');
    expect(utterance.voice).toBe(simplifiedVoice);
  });

  it('speaks only the active HR reading in simplified Chinese', () => {
    const capturedAt = '2026-08-17T08:00:00.000Z';
    const readings = emptyReadingMap(capturedAt);
    readings.hr = formatDemoReading('hr', [118], capturedAt);
    readings.temp = formatDemoReading('temp', [37.6], capturedAt);

    expect(snapshotSpeech(readings)).toBe('监护自动记录。心率118次每分钟。请核对。');
  });
});
