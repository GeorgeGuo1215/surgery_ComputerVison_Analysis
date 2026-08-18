import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createWorker: vi.fn(),
  recognize: vi.fn(),
  setParameters: vi.fn(),
  terminate: vi.fn(),
}));

vi.mock('tesseract.js', () => ({
  createWorker: mocks.createWorker,
  OEM: { LSTM_ONLY: 1 },
  PSM: { SINGLE_LINE: '7', SINGLE_WORD: '8' },
}));

import { BrowserOCR, resolveOCRAssetPaths } from './ocr';

describe('self-hosted browser OCR resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createWorker.mockResolvedValue({
      recognize: mocks.recognize,
      setParameters: mocks.setParameters,
      terminate: mocks.terminate,
    });
    mocks.setParameters.mockResolvedValue(undefined);
  });

  it('keeps every resource under a GitHub Pages project base path', () => {
    expect(resolveOCRAssetPaths('https://example.github.io/petor/index.html')).toEqual({
      workerPath: 'https://example.github.io/petor/vendor/tesseract/worker.min.js',
      corePath: 'https://example.github.io/petor/vendor/tesseract/core/',
      langPath: 'https://example.github.io/petor/vendor/tesseract/lang/',
    });
  });

  it('initializes Tesseract only from same-origin vendored resources', async () => {
    const ocr = new BrowserOCR();
    await ocr.initialize();

    expect(mocks.createWorker).toHaveBeenCalledOnce();
    expect(mocks.createWorker).toHaveBeenCalledWith(
      'eng',
      1,
      expect.objectContaining({
        workerPath: new URL('./vendor/tesseract/worker.min.js', document.baseURI).href,
        corePath: new URL('./vendor/tesseract/core/', document.baseURI).href,
        langPath: new URL('./vendor/tesseract/lang/', document.baseURI).href,
        workerBlobURL: false,
      }),
    );
    expect(mocks.setParameters).toHaveBeenCalledWith({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '8',
      preserve_interword_spaces: '1',
    });
  });
});
