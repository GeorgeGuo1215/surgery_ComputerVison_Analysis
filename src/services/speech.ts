import type { ReadingMap } from '../domain/types';
import { ACTIVE_VITAL_DEFINITIONS, isAcceptedHeartRateReading } from '../domain/vitals';

export function canSpeak(): boolean {
  return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export function isSimplifiedChineseVoice(voice: Pick<SpeechSynthesisVoice, 'lang'>): boolean {
  const language = voice.lang.toLowerCase().replaceAll('_', '-');
  return (
    language === 'zh-cn' ||
    language === 'zh-sg' ||
    language.startsWith('zh-hans') ||
    language.startsWith('cmn-hans') ||
    language === 'cmn-cn'
  );
}

export function snapshotSpeech(readings: ReadingMap): string {
  const spokenUnits: Record<string, string> = {
    bpm: '次每分钟',
    '%': '百分比',
    mmHg: '毫米汞柱',
    '/min': '次每分钟',
    '°C': '摄氏度',
  };
  const parts = ACTIVE_VITAL_DEFINITIONS.flatMap(({ key, label, unit }) => {
    const reading = readings[key];
    if (
      reading.status !== 'ok'
      || reading.display == null
      || (key === 'hr' && !isAcceptedHeartRateReading(reading))
    ) return [];
    return `${label}${reading.display}${spokenUnits[unit] ?? unit}`;
  });
  return parts.length > 0
    ? `监护自动记录。${parts.join('，')}。请核对。`
    : '本次未识别到可靠的监护数据，请人工核对。';
}

export function speak(text: string): boolean {
  if (!canSpeak()) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 0.95;
  utterance.pitch = 1;
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find(isSimplifiedChineseVoice) ?? null;
  window.speechSynthesis.speak(utterance);
  return true;
}
