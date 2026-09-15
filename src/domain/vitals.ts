import type {
  NormalizedROI,
  ParsedVital,
  ReadingMap,
  VitalDefinition,
  VitalKey,
  VitalReading,
} from './types';

export const HEART_RATE_CAPTURE_RANGE = { min: 0, max: 200 } as const;

export const VITAL_DEFINITIONS: VitalDefinition[] = [
  {
    key: 'hr',
    label: '心率',
    shortLabel: 'HR',
    unit: 'bpm',
    color: '#64e6b6',
    min: HEART_RATE_CAPTURE_RANGE.min,
    max: HEART_RATE_CAPTURE_RANGE.max,
    maxJump: 100,
    precision: 0,
    defaultROI: { x: 0.035, y: 0.08, width: 0.24, height: 0.2 },
    demoValue: [118],
  },
  {
    key: 'spo2',
    label: '血氧饱和度',
    shortLabel: 'SpO₂',
    unit: '%',
    color: '#72b7ff',
    min: 40,
    max: 100,
    maxJump: 12,
    precision: 0,
    defaultROI: { x: 0.715, y: 0.08, width: 0.14, height: 0.2 },
    demoValue: [98],
  },
  {
    key: 'pr',
    label: '脉率',
    shortLabel: 'PR',
    unit: 'bpm',
    color: '#4cd6dc',
    min: 20,
    max: 350,
    maxJump: 100,
    precision: 0,
    defaultROI: { x: 0.865, y: 0.1, width: 0.115, height: 0.18 },
    demoValue: [117],
  },
  {
    key: 'nibp',
    label: '无创血压',
    shortLabel: 'NIBP',
    unit: 'mmHg',
    color: '#ffca67',
    min: 15,
    max: 300,
    maxJump: 80,
    precision: 0,
    defaultROI: { x: 0.035, y: 0.61, width: 0.39, height: 0.2 },
    demoValue: [112, 68, 82],
  },
  {
    key: 'rr',
    label: '呼吸率',
    shortLabel: 'RR',
    unit: '/min',
    color: '#f29bd5',
    min: 0,
    max: 180,
    maxJump: 50,
    precision: 0,
    defaultROI: { x: 0.715, y: 0.34, width: 0.25, height: 0.2 },
    demoValue: [18],
  },
  {
    key: 'etco2',
    label: '呼气末二氧化碳',
    shortLabel: 'EtCO₂',
    unit: 'mmHg',
    color: '#ad8cff',
    min: 0,
    max: 120,
    maxJump: 35,
    precision: 0,
    defaultROI: { x: 0.39, y: 0.34, width: 0.24, height: 0.2 },
    demoValue: [38],
  },
  {
    key: 'fico2',
    label: '吸气二氧化碳',
    shortLabel: 'FiCO₂',
    unit: 'mmHg',
    color: '#95a7b5',
    min: 0,
    max: 80,
    maxJump: 25,
    precision: 0,
    defaultROI: { x: 0.39, y: 0.61, width: 0.24, height: 0.15 },
    demoValue: [1],
  },
  {
    key: 'temp',
    label: '体温',
    shortLabel: 'TEMP',
    unit: '°C',
    color: '#ff8d77',
    min: 20,
    max: 45,
    maxJump: 3,
    precision: 1,
    defaultROI: { x: 0.715, y: 0.61, width: 0.25, height: 0.2 },
    demoValue: [37.6],
  },
];

export const VITAL_KEYS = VITAL_DEFINITIONS.map(({ key }) => key);

/** Current product scope. Other definitions stay in the schema for later rollout. */
export const ACTIVE_VITAL_KEYS: VitalKey[] = ['hr', 'rr'];
export const ACTIVE_VITAL_DEFINITIONS = VITAL_DEFINITIONS.filter(
  ({ key }) => ACTIVE_VITAL_KEYS.includes(key),
);
export const DEFERRED_VITAL_KEYS = VITAL_KEYS.filter(
  (key) => !ACTIVE_VITAL_KEYS.includes(key),
);

export const VITAL_BY_KEY = Object.fromEntries(
  VITAL_DEFINITIONS.map((definition) => [definition.key, definition]),
) as Record<VitalKey, VitalDefinition>;

export const DEFAULT_ROIS = Object.fromEntries(
  VITAL_DEFINITIONS.map(({ key, defaultROI }) => [key, defaultROI]),
) as Record<VitalKey, NormalizedROI>;

/**
 * Mindray iMEC8 Vet profile calibrated against the supplied 544 × 960 portrait
 * fixture. Coordinates are relative to the complete video frame, not the
 * monitor bezel. They remain user-adjustable because the phone position can
 * move between recordings.
 */
export const MINDRAY_IMEC8_VIDEO_ROIS: Record<VitalKey, NormalizedROI> = {
  hr: { x: 0.65, y: 0.525, width: 0.15, height: 0.065 },
  spo2: { x: 0.64, y: 0.59, width: 0.16, height: 0.065 },
  pr: { x: 0.798, y: 0.59, width: 0.13, height: 0.065 },
  nibp: { x: 0.6, y: 0.825, width: 0.35, height: 0.067 },
  rr: { x: 0.63, y: 0.734, width: 0.17, height: 0.075 },
  etco2: { x: 0.63, y: 0.656, width: 0.17, height: 0.076 },
  fico2: { x: 0.8, y: 0.695, width: 0.13, height: 0.055 },
  temp: { x: 0, y: 0.805, width: 0.23, height: 0.065 },
};

/**
 * Second iMEC8 Vet portrait profile calibrated against the supplied 10:02
 * reference-comparison video (`1.mp4`, 544 × 960). Its monitor is framed
 * materially higher than the first fixture, so the profiles must not be
 * silently interchanged. Near the end, the phone shifts about +0.06 on x; the
 * tight HR crop can then see only one digit. Single-character HR candidates
 * must stay low-confidence rather than being auto-accepted. Users can redraw
 * every ROI.
 */
export const MINDRAY_IMEC8_REFERENCE_VIDEO_ROIS: Record<VitalKey, NormalizedROI> = {
  hr: { x: 0.625, y: 0.4042, width: 0.1078, height: 0.0444 },
  spo2: { x: 0.6348, y: 0.4667, width: 0.1103, height: 0.0514 },
  pr: { x: 0.7745, y: 0.4736, width: 0.0931, height: 0.0472 },
  nibp: { x: 0.3235, y: 0.6069, width: 0.2328, height: 0.0333 },
  rr: { x: 0.7917, y: 0.5139, width: 0.0686, height: 0.0361 },
  etco2: { x: 0.6397, y: 0.5361, width: 0.1152, height: 0.0486 },
  fico2: { x: 0.799, y: 0.55, width: 0.049, height: 0.0347 },
  temp: { x: 0.0564, y: 0.6, width: 0.1176, height: 0.0361 },
};

const CHARACTER_MAP: Record<string, string> = {
  '日': '8',
  b: '8',
  B: '8',
  o: '0',
  O: '0',
  q: '9',
  Q: '9',
  l: '1',
  I: '1',
  i: '1',
  '|': '1',
  s: '5',
  S: '5',
  z: '2',
  Z: '2',
  t: '7',
  T: '7',
  '一': '1',
  '二': '2',
  '三': '3',
  '四': '4',
  '五': '5',
  '／': '/',
  '\\': '/',
  ',': '.',
};

export function normalizeOCRText(rawText: string): string {
  return [...rawText]
    .map((character) => CHARACTER_MAP[character] ?? character)
    .join('')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HEART_RATE_CHARACTER_MAP: Record<string, string> = {
  O: '0',
  o: '0',
  I: '1',
  i: '1',
  l: '1',
  '|': '1',
  S: '5',
  s: '5',
};

export type HeartRatePostprocessResult =
  | {
      outcome: 'parsed';
      parsed: ParsedVital;
      normalizedText: string;
      candidates: number[];
      correctionCount: number;
    }
  | {
      outcome: 'not-found' | 'ambiguous' | 'invalid';
      parsed: null;
      normalizedText: string;
      candidates: number[];
      reason: string;
    };

/**
 * Manual corrections intentionally do not reuse OCR character substitutions.
 * A clinician must enter one plain integer in the 0–200 capture range.
 */
export function parseManualHeartRateInput(input: string): ParsedVital | null {
  const normalized = input.trim().normalize('NFKC');
  if (!/^(?:0|[1-9]\d{0,2})$/u.test(normalized)) return null;
  const value = Number(normalized);
  if (
    !Number.isInteger(value)
    || value < HEART_RATE_CAPTURE_RANGE.min
    || value > HEART_RATE_CAPTURE_RANGE.max
  ) return null;
  return { display: String(value), values: [value] };
}

/**
 * Central invariant for values that may enter the reliable HR column.
 * Automatic one-character OCR remains review-only; a clinician may explicitly
 * confirm such a value through the strict manual correction path.
 */
export function isAcceptedHeartRateReading(reading: VitalReading): boolean {
  if (reading.status !== 'ok' && reading.status !== 'manual-corrected') return false;
  if (reading.values.length !== 1) return false;
  const value = reading.values[0];
  if (
    !Number.isInteger(value)
    || value < HEART_RATE_CAPTURE_RANGE.min
    || value > HEART_RATE_CAPTURE_RANGE.max
    || reading.display !== String(value)
  ) return false;
  return reading.status === 'manual-corrected' || reading.display.length > 1;
}

function stripHeartRateLabels(rawText: string): string {
  return rawText
    .normalize('NFKC')
    .replace(/heart\s*rate/giu, ' ')
    .replace(/(^|[^A-Za-z])(?:hr|ecg|bpm|pulse)(?=$|[^A-Za-z])/giu, '$1 ');
}

function normalizeHeartRateToken(token: string): string {
  return [...token].map((character) => HEART_RATE_CHARACTER_MAP[character] ?? character).join('');
}

/**
 * Converts a tightly cropped monitor HR OCR string into one integer candidate.
 * Corrections are limited to digit-shaped tokens so ordinary labels such as
 * "SENSOR OK" cannot manufacture a heart-rate value. Multiple distinct
 * candidates are rejected instead of being selected from history.
 */
export function postprocessHeartRateText(rawText: string): HeartRatePostprocessResult {
  const withoutLabels = stripHeartRateLabels(rawText);
  const tokenPattern = /(?<![A-Za-z])[0-9OoIil|Ss]+(?![A-Za-z])/gu;
  const matches = [...withoutLabels.matchAll(tokenPattern)];
  const tokens = matches.map(([token]) => token);
  const normalizedTokens = tokens.map(normalizeHeartRateToken);
  const normalizedText = withoutLabels
    .replace(tokenPattern, (token) => normalizeHeartRateToken(token))
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = normalizedTokens
    .filter((token) => /^\d+$/.test(token))
    .map(Number)
    .filter(Number.isFinite);

  if (candidates.length === 0) {
    return {
      outcome: 'not-found',
      parsed: null,
      normalizedText,
      candidates,
      reason: '未找到唯一的 HR 整数候选',
    };
  }
  if (candidates.length > 1) {
    return {
      outcome: 'ambiguous',
      parsed: null,
      normalizedText,
      candidates,
      reason: `发现多个 HR 候选（${candidates.join('、')}），拒绝猜测`,
    };
  }

  const sourceToken = tokens[0];
  if (!/\d/.test(sourceToken)) {
    return {
      outcome: 'not-found',
      parsed: null,
      normalizedText,
      candidates: [],
      reason: 'HR 候选不含真实数字，拒绝仅凭字母猜测',
    };
  }
  const matchIndex = matches[0].index ?? 0;
  const previousCharacter = withoutLabels.slice(0, matchIndex).trimEnd().at(-1) ?? '';
  if (/[-−﹣]/u.test(previousCharacter)) {
    return {
      outcome: 'invalid',
      parsed: null,
      normalizedText,
      candidates,
      reason: 'HR 不接受负数候选',
    };
  }
  const normalizedToken = normalizedTokens[0];
  if (normalizedToken.length > 1 && normalizedToken.startsWith('0')) {
    return {
      outcome: 'invalid',
      parsed: null,
      normalizedText,
      candidates,
      reason: 'HR 不接受带前导零的候选',
    };
  }

  const value = candidates[0];
  const correctionCount = [...sourceToken]
    .filter((character) => (HEART_RATE_CHARACTER_MAP[character] ?? character) !== character)
    .length;
  return {
    outcome: 'parsed',
    parsed: { display: String(value), values: [value] },
    normalizedText,
    candidates,
    correctionCount,
  };
}

function formatNumber(value: number, precision: number): string {
  return value.toFixed(precision);
}

function parseNIBP(text: string): ParsedVital | null {
  const slashMatch = text.match(/(\d{2,3})\s*[/]\s*(\d{2,3})(?:\s*[([]?\s*(\d{2,3})\s*[)\]]?)?/);
  if (slashMatch) {
    const values = slashMatch.slice(1).filter(Boolean).map(Number);
    const [systolic, diastolic, mean] = values;
    return {
      display: `${systolic}/${diastolic}${mean !== undefined ? ` (${mean})` : ''}`,
      values,
    };
  }

  const groups = text.match(/\d{2,3}/g)?.map(Number) ?? [];
  if (groups.length >= 2) {
    const values = groups.slice(0, 3);
    return {
      display: `${values[0]}/${values[1]}${values[2] !== undefined ? ` (${values[2]})` : ''}`,
      values,
    };
  }
  return null;
}

export function parseVitalText(key: VitalKey, rawText: string): ParsedVital | null {
  if (key === 'hr') return postprocessHeartRateText(rawText).parsed;
  if (key === 'rr') {
    const text = rawText.normalize('NFKC').trim()
      .replace(/^(?:RR|RESP|呼吸率)\s*[:：=]?\s*/iu, '')
      .replace(/\s*(?:次\/分钟|次每分钟|\/min|brpm)\s*$/iu, '').trim();
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(text)) return null;
    return { display: text, values: [Number(text)] };
  }
  const text = normalizeOCRText(rawText);
  if (!text) return null;
  if (key === 'nibp') return parseNIBP(text);

  const definition = VITAL_BY_KEY[key];
  let numericText = text.match(/\d+(?:\.\d+)?/)?.[0];
  if (!numericText) return null;

  if (key === 'temp' && !numericText.includes('.') && numericText.length === 3) {
    numericText = `${numericText.slice(0, 2)}.${numericText.slice(2)}`;
  }

  const value = Number(numericText);
  if (!Number.isFinite(value)) return null;
  return {
    display: formatNumber(value, definition.precision),
    values: [value],
  };
}

export function valuesWithinCaptureRange(key: VitalKey, values: number[]): boolean {
  if (values.length === 0) return false;
  if (key === 'rr') return values.length === 1 && Number.isInteger(values[0]) && values[0] >= 0 && values[0] <= 180;
  if (key === 'hr') {
    return values.length === 1 && Number.isInteger(values[0])
      && values[0] >= HEART_RATE_CAPTURE_RANGE.min
      && values[0] <= HEART_RATE_CAPTURE_RANGE.max;
  }
  if (key === 'nibp') {
    const [systolic, diastolic, mean] = values;
    return (
      systolic >= 30 &&
      systolic <= 300 &&
      diastolic >= 15 &&
      diastolic <= 220 &&
      systolic > diastolic &&
      (mean === undefined || (mean >= diastolic && mean <= systolic))
    );
  }
  const { min, max } = VITAL_BY_KEY[key];
  return values[0] >= min && values[0] <= max;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function evaluateReading(
  key: VitalKey,
  rawText: string,
  confidence: number,
  capturedAt: string,
  recentAccepted: VitalReading[] = [],
): VitalReading {
  const heartRatePostprocess = key === 'hr' ? postprocessHeartRateText(rawText) : null;
  const parsed = key === 'hr' ? heartRatePostprocess!.parsed : parseVitalText(key, rawText);
  if (!parsed) {
    return {
      key,
      display: null,
      values: [],
      rawText,
      confidence,
      status: 'not-found',
      capturedAt,
      reason: heartRatePostprocess && heartRatePostprocess.outcome !== 'parsed'
        ? heartRatePostprocess.reason
        : '未找到可解析的数字',
    };
  }

  if (!valuesWithinCaptureRange(key, parsed.values)) {
    return {
      key,
      ...parsed,
      rawText,
      confidence,
      status: 'out-of-range',
      capturedAt,
      reason: key === 'hr'
        ? `超出 HR ${HEART_RATE_CAPTURE_RANGE.min}–${HEART_RATE_CAPTURE_RANGE.max} bpm 后处理范围`
        : '超出设备可能显示范围',
    };
  }

  const confidenceThreshold = ACTIVE_VITAL_KEYS.includes(key) ? 65 : 55;
  if (confidence < confidenceThreshold) {
    return {
      key,
      ...parsed,
      rawText,
      confidence,
      status: 'low-confidence',
      capturedAt,
      reason: `OCR 置信度低于 ${confidenceThreshold}%`,
    };
  }

  if (key === 'hr' && parsed.display.length === 1) {
    return {
      key,
      ...parsed,
      rawText,
      confidence,
      status: 'low-confidence',
      capturedAt,
      reason: '单字符 HR 候选可能来自 ROI 截断，需人工核对',
    };
  }

  if (heartRatePostprocess?.outcome === 'parsed' && heartRatePostprocess.correctionCount > 0) {
    return {
      key,
      ...parsed,
      rawText,
      confidence,
      status: 'low-confidence',
      capturedAt,
      reason: `HR 候选应用了 ${heartRatePostprocess.correctionCount} 次字符纠正，需多帧一致确认`,
    };
  }

  const historicalValues = recentAccepted
    .filter((reading) => reading.status === 'ok' && reading.values.length > 0)
    .slice(-5)
    .map((reading) => reading.values[0]);
  const historicalMedian = median(historicalValues);
  const maxJump = key === 'hr' && historicalMedian !== null
    ? Math.max(20, historicalMedian * 0.35)
    : VITAL_BY_KEY[key].maxJump;
  if (historicalMedian !== null && Math.abs(parsed.values[0] - historicalMedian) > maxJump) {
    return {
      key,
      ...parsed,
      rawText,
      confidence,
      status: 'low-confidence',
      capturedAt,
      reason: `与近期中位数相差超过 ${Math.round(maxJump * 10) / 10}`,
    };
  }

  return {
    key,
    ...parsed,
    rawText,
    confidence,
    status: 'ok',
    capturedAt,
  };
}

export function emptyReadingMap(capturedAt = new Date().toISOString()): ReadingMap {
  return Object.fromEntries(
    VITAL_KEYS.map((key) => [
      key,
      {
        key,
        display: null,
        values: [],
        rawText: '',
        confidence: 0,
        status: 'not-configured',
        capturedAt,
        reason: ACTIVE_VITAL_KEYS.includes(key) ? undefined : '当前版本启用 HR 心率与 RR 呼吸率，此字段后置',
      } satisfies VitalReading,
    ]),
  ) as unknown as ReadingMap;
}

export function formatDemoReading(key: VitalKey, values: number[], capturedAt: string): VitalReading {
  const definition = VITAL_BY_KEY[key];
  const display =
    key === 'nibp'
      ? `${Math.round(values[0])}/${Math.round(values[1])} (${Math.round(values[2])})`
      : values[0].toFixed(definition.precision);
  return {
    key,
    display,
    values,
    rawText: display,
    confidence: 99,
    status: 'ok',
    capturedAt,
  };
}

/** RR's 0–180 bound is an OCR capture constraint, not a clinical normal range. */
export function parseManualRespiratoryRateInput(input: string): ParsedVital | null {
  const text = input.normalize('NFKC').trim();
  if (!/^(?:0|[1-9]\d{0,2})$/u.test(text)) return null;
  const values = [Number(text)];
  return valuesWithinCaptureRange('rr', values) ? { display: text, values } : null;
}

export function isAcceptedVitalReading(reading: VitalReading): boolean {
  if (reading.key === 'hr') return isAcceptedHeartRateReading(reading);
  if (reading.status !== 'ok' && reading.status !== 'manual-corrected') return false;
  if (reading.key === 'rr') return valuesWithinCaptureRange('rr', reading.values)
    && reading.display === String(reading.values[0]);
  return reading.display != null && valuesWithinCaptureRange(reading.key, reading.values);
}
