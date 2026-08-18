import { createWorker, OEM, PSM, type Worker as TesseractWorker } from 'tesseract.js';
import type { NormalizedROI, OCRResult } from '../domain/types';

export type OCRProgress = (progress: number, status: string) => void;

export interface OCRAssetPaths {
  workerPath: string;
  corePath: string;
  langPath: string;
}

/** Resolve against the deployed document so GitHub Pages project subpaths keep working. */
export function resolveOCRAssetPaths(baseURI: string = document.baseURI): OCRAssetPaths {
  return {
    workerPath: new URL('./vendor/tesseract/worker.min.js', baseURI).href,
    corePath: new URL('./vendor/tesseract/core/', baseURI).href,
    langPath: new URL('./vendor/tesseract/lang/', baseURI).href,
  };
}

export function captureFrozenFrame(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法冻结当前视频帧');
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight);
  return canvas;
}

function otsuThreshold(gray: Uint8ClampedArray): number {
  const histogram = new Uint32Array(256);
  for (const value of gray) histogram[value] += 1;
  const total = gray.length;
  let sum = 0;
  for (let index = 0; index < 256; index += 1) sum += index * histogram[index];
  let sumBackground = 0;
  let backgroundWeight = 0;
  let bestVariance = -1;
  let threshold = 127;
  for (let index = 0; index < 256; index += 1) {
    backgroundWeight += histogram[index];
    if (backgroundWeight === 0) continue;
    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;
    sumBackground += index * histogram[index];
    const meanBackground = sumBackground / backgroundWeight;
    const meanForeground = (sum - sumBackground) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = index;
    }
  }
  return threshold;
}

export function cropAndPreprocess(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  roi: NormalizedROI,
): HTMLCanvasElement {
  const cropWidth = Math.max(8, Math.round(sourceWidth * roi.width));
  const cropHeight = Math.max(8, Math.round(sourceHeight * roi.height));
  const scale = Math.max(2, Math.min(4, Math.ceil(160 / cropHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = cropWidth * scale;
  canvas.height = cropHeight * scale;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('无法创建图像处理画布');
  context.imageSmoothingEnabled = false;
  context.drawImage(
    source,
    Math.round(sourceWidth * roi.x),
    Math.round(sourceHeight * roi.y),
    cropWidth,
    cropHeight,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8ClampedArray(canvas.width * canvas.height);
  let average = 0;
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    const red = image.data[offset];
    const green = image.data[offset + 1];
    const blue = image.data[offset + 2];
    const value = Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
    gray[index] = value;
    average += value;
  }
  average /= gray.length;
  const threshold = otsuThreshold(gray);
  const invert = average < 128;
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    const isBright = gray[index] > threshold;
    const foreground = invert ? isBright : !isBright;
    const output = foreground ? 0 : 255;
    image.data[offset] = output;
    image.data[offset + 1] = output;
    image.data[offset + 2] = output;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export function cropRawForOCR(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  roi: NormalizedROI,
): HTMLCanvasElement {
  const cropWidth = Math.max(8, Math.round(sourceWidth * roi.width));
  const cropHeight = Math.max(8, Math.round(sourceHeight * roi.height));
  const canvas = document.createElement('canvas');
  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建原色 OCR 裁剪画布');
  context.drawImage(
    source,
    Math.round(sourceWidth * roi.x),
    Math.round(sourceHeight * roi.y),
    cropWidth,
    cropHeight,
    0,
    0,
    cropWidth,
    cropHeight,
  );
  return canvas;
}

export class BrowserOCR {
  private worker: TesseractWorker | null = null;

  private initializing: Promise<TesseractWorker> | null = null;

  constructor(private readonly onProgress?: OCRProgress) {}

  async initialize(): Promise<void> {
    await this.getWorker();
  }

  private async getWorker(): Promise<TesseractWorker> {
    if (this.worker) return this.worker;
    if (!this.initializing) {
      const assetPaths = resolveOCRAssetPaths();
      this.initializing = createWorker('eng', OEM.LSTM_ONLY, {
        ...assetPaths,
        // The worker is same-origin; avoid a blob wrapper and its stricter CSP requirements.
        workerBlobURL: false,
        logger: (message) => {
          this.onProgress?.(message.progress ?? 0, message.status ?? 'OCR');
        },
      }).then(async (worker) => {
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789',
          tessedit_pageseg_mode: PSM.SINGLE_WORD,
          preserve_interword_spaces: '1',
        });
        this.worker = worker;
        return worker;
      });
    }
    return this.initializing;
  }

  async recognize(image: HTMLCanvasElement): Promise<OCRResult> {
    const worker = await this.getWorker();
    const result = await worker.recognize(image);
    return {
      text: result.data.text.trim(),
      confidence: result.data.confidence,
    };
  }

  async terminate(): Promise<void> {
    if (this.worker) await this.worker.terminate();
    this.worker = null;
    this.initializing = null;
  }
}
