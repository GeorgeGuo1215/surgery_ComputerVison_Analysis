import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCamera } from './useCamera';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function cameraStream(deviceId: string) {
  const stop = vi.fn();
  const track = {
    stop,
    addEventListener: vi.fn(),
    getSettings: vi.fn(() => ({ deviceId })),
  } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: vi.fn(() => [track]),
    getVideoTracks: vi.fn(() => [track]),
  } as unknown as MediaStream;
  return { stream, stop };
}

function videoElement() {
  return {
    srcObject: null,
    setAttribute: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLVideoElement;
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

function installMediaDevices(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia,
      enumerateDevices: vi.fn().mockResolvedValue([]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    configurable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalMediaDevices) Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
  else Reflect.deleteProperty(navigator, 'mediaDevices');
  if (originalSecureContext) Object.defineProperty(window, 'isSecureContext', originalSecureContext);
  else Reflect.deleteProperty(window, 'isSecureContext');
});

describe('useCamera request generations', () => {
  it('stops a stream that resolves after stop without attaching it or restoring live state', async () => {
    const pending = deferred<MediaStream>();
    installMediaDevices(vi.fn(() => pending.promise));
    const video = videoElement();
    const videoRef = { current: video };
    const { result } = renderHook(() => useCamera(videoRef));
    const stale = cameraStream('rear');
    let startResult!: Promise<boolean>;

    act(() => {
      startResult = result.current.start();
    });
    expect(result.current.status).toBe('requesting');
    act(() => result.current.stop());
    expect(result.current.status).toBe('idle');

    let started = true;
    await act(async () => {
      pending.resolve(stale.stream);
      started = await startResult;
    });

    expect(started).toBe(false);
    expect(stale.stop).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('ignores an error from a request invalidated by stop', async () => {
    const pending = deferred<MediaStream>();
    installMediaDevices(vi.fn(() => pending.promise));
    const video = videoElement();
    const videoRef = { current: video };
    const { result } = renderHook(() => useCamera(videoRef));
    let startResult!: Promise<boolean>;

    act(() => {
      startResult = result.current.start();
    });
    act(() => result.current.stop());

    let started = true;
    await act(async () => {
      pending.reject(new DOMException('denied later', 'NotAllowedError'));
      started = await startResult;
    });

    expect(started).toBe(false);
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBe('');
  });

  it('keeps the newest start when an older request resolves last', async () => {
    const firstPending = deferred<MediaStream>();
    const secondPending = deferred<MediaStream>();
    installMediaDevices(vi.fn()
      .mockImplementationOnce(() => firstPending.promise)
      .mockImplementationOnce(() => secondPending.promise));
    const video = videoElement();
    const videoRef = { current: video };
    const { result } = renderHook(() => useCamera(videoRef));
    const first = cameraStream('camera-1');
    const second = cameraStream('camera-2');
    let firstResult!: Promise<boolean>;
    let secondResult!: Promise<boolean>;

    act(() => {
      firstResult = result.current.start();
      secondResult = result.current.start();
    });

    let secondStarted = false;
    await act(async () => {
      secondPending.resolve(second.stream);
      secondStarted = await secondResult;
    });
    expect(secondStarted).toBe(true);
    expect(video.srcObject).toBe(second.stream);
    expect(result.current.status).toBe('live');

    let firstStarted = true;
    await act(async () => {
      firstPending.resolve(first.stream);
      firstStarted = await firstResult;
    });

    expect(firstStarted).toBe(false);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();
    expect(video.srcObject).toBe(second.stream);
    expect(result.current.selectedDeviceId).toBe('camera-2');
    expect(result.current.status).toBe('live');
  });

  it('stops a request that resolves after unmount without touching the video element', async () => {
    const pending = deferred<MediaStream>();
    installMediaDevices(vi.fn(() => pending.promise));
    const video = videoElement();
    const videoRef = { current: video };
    const { result, unmount } = renderHook(() => useCamera(videoRef));
    const stale = cameraStream('rear');
    let startResult!: Promise<boolean>;

    act(() => {
      startResult = result.current.start();
    });
    unmount();
    pending.resolve(stale.stream);

    await expect(startResult).resolves.toBe(false);
    expect(stale.stop).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });
});
