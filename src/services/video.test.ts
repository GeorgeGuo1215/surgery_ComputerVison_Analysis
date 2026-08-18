import { afterEach, describe, expect, it, vi } from 'vitest';
import { seekVideoFrame } from './video';

interface MockVideoOptions {
  paused?: boolean;
  play?: () => Promise<void>;
  errorMessage?: string;
}

function decodedVideo(options: MockVideoOptions = {}) {
  const callbacks: VideoFrameRequestCallback[] = [];
  const listeners = new Map<string, EventListener>();
  const play = options.play ?? vi.fn().mockResolvedValue(undefined);
  const pause = vi.fn();
  const cancelVideoFrameCallback = vi.fn();
  const video = {
    duration: 10,
    currentTime: 2,
    paused: options.paused ?? true,
    error: options.errorMessage ? { message: options.errorMessage } : null,
    play,
    pause,
    requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }),
    cancelVideoFrameCallback,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.set(type, listener as EventListener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    }),
  } as unknown as HTMLVideoElement;
  return {
    video,
    callbacks,
    play,
    pause,
    cancelVideoFrameCallback,
    emit(type: string) {
      listeners.get(type)?.(new Event(type));
    },
  };
}

describe('reliable offline video frame seeking', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects instead of treating currentTime and readyState as proof when rVFC is unavailable', async () => {
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame');
    const video = {
      duration: 10,
      currentTime: 2,
      readyState: HTMLMediaElement.HAVE_ENOUGH_DATA,
    } as HTMLVideoElement;

    await expect(seekVideoFrame(video, 2)).rejects.toThrow(/requestVideoFrameCallback.*可靠逐秒/);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('waits for metadata.mediaTime within ±0.05s, briefly plays a paused video, then restores pause', async () => {
    const fixture = decodedVideo();
    const result = seekVideoFrame(fixture.video, 2, 1_000);
    await Promise.resolve();

    expect(fixture.play).toHaveBeenCalledOnce();
    expect(fixture.callbacks).toHaveLength(1);
    fixture.callbacks[0](0, { mediaTime: 1.5 } as VideoFrameCallbackMetadata);
    expect(fixture.callbacks).toHaveLength(2);
    fixture.callbacks[1](0, { mediaTime: 2.049 } as VideoFrameCallbackMetadata);

    await expect(result).resolves.toBe(2.049);
    expect(fixture.pause).toHaveBeenCalledOnce();
    expect(fixture.cancelVideoFrameCallback).toHaveBeenCalledWith(2);
  });

  it('rejects and restores pause when temporary playback fails', async () => {
    const fixture = decodedVideo({
      play: vi.fn().mockRejectedValue(new DOMException('autoplay blocked', 'NotAllowedError')),
    });

    await expect(seekVideoFrame(fixture.video, 2, 1_000)).rejects.toThrow(/无法临时播放.*autoplay blocked/);
    expect(fixture.pause).toHaveBeenCalledOnce();
    expect(fixture.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
  });

  it('rejects on decoded-frame timeout, cancels the callback, and restores pause', async () => {
    vi.useFakeTimers();
    const fixture = decodedVideo();
    const result = seekVideoFrame(fixture.video, 2, 500);
    await Promise.resolve();
    const rejection = expect(result).rejects.toThrow(/解码帧超时/);

    await vi.advanceTimersByTimeAsync(501);
    await rejection;
    expect(fixture.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect(fixture.pause).toHaveBeenCalledOnce();
  });

  it('rejects a media decode error and restores the original paused state', async () => {
    const fixture = decodedVideo({ errorMessage: 'codec failure' });
    const result = seekVideoFrame(fixture.video, 2, 1_000);
    await Promise.resolve();
    const rejection = expect(result).rejects.toThrow('codec failure');
    fixture.emit('error');

    await rejection;
    expect(fixture.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect(fixture.pause).toHaveBeenCalledOnce();
  });

  it('does not pause a video that was already playing', async () => {
    const fixture = decodedVideo({ paused: false });
    const result = seekVideoFrame(fixture.video, 2, 1_000);
    await Promise.resolve();
    fixture.callbacks[0](0, { mediaTime: 2 } as VideoFrameCallbackMetadata);

    await expect(result).resolves.toBe(2);
    expect(fixture.play).not.toHaveBeenCalled();
    expect(fixture.pause).not.toHaveBeenCalled();
  });
});
