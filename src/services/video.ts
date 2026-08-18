const FRAME_TIME_TOLERANCE_SECONDS = 0.05;

interface VideoFrameCallbackAPI {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function frameCallbackAPI(video: HTMLVideoElement): Required<VideoFrameCallbackAPI> | null {
  const candidate = video as unknown as VideoFrameCallbackAPI;
  if (typeof candidate.requestVideoFrameCallback !== 'function') return null;
  return {
    requestVideoFrameCallback: candidate.requestVideoFrameCallback.bind(video),
    cancelVideoFrameCallback: typeof candidate.cancelVideoFrameCallback === 'function'
      ? candidate.cancelVideoFrameCallback.bind(video)
      : () => undefined,
  };
}

function seekToTarget(
  video: HTMLVideoElement,
  targetSeconds: number,
  timeoutMs: number,
): Promise<void> {
  if (Math.abs(video.currentTime - targetSeconds) < 0.015) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout = 0;
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      window.clearTimeout(timeout);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish(new Error(video.error?.message || '视频定位失败'));
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    timeout = window.setTimeout(() => finish(new Error('视频定位超时')), timeoutMs);
    try {
      video.currentTime = targetSeconds;
    } catch (error) {
      finish(new Error(`无法定位视频目标时间：${errorMessage(error)}`));
    }
  });
}

function waitForDecodedTargetFrame(
  video: HTMLVideoElement,
  frameAPI: Required<VideoFrameCallbackAPI>,
  targetSeconds: number,
  timeoutMs: number,
): Promise<number> {
  const restorePaused = video.paused;

  return new Promise((resolve, reject) => {
    let settled = false;
    let frameHandle: number | null = null;
    let timeout = 0;

    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('error', onError);
      if (frameHandle != null) {
        try {
          frameAPI.cancelVideoFrameCallback(frameHandle);
        } catch {
          // A callback that is already running may no longer be cancellable.
        }
      }
      if (restorePaused) {
        try {
          video.pause();
        } catch {
          // The result is already known; restoring a paused source is best effort.
        }
      }
    };

    const finish = (mediaTime?: number, error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(mediaTime!);
    };

    const onError = () => finish(
      undefined,
      new Error(video.error?.message || '视频解码目标帧失败'),
    );

    const requestNextFrame = () => {
      if (settled) return;
      frameHandle = frameAPI.requestVideoFrameCallback((_now, metadata) => {
        if (settled) return;
        const mediaTime = metadata.mediaTime;
        if (!Number.isFinite(mediaTime)) {
          finish(undefined, new Error('浏览器未返回可靠的解码帧媒体时间'));
          return;
        }
        if (Math.abs(mediaTime - targetSeconds) <= FRAME_TIME_TOLERANCE_SECONDS) {
          finish(mediaTime);
          return;
        }
        requestNextFrame();
      });
    };

    video.addEventListener('error', onError, { once: true });
    timeout = window.setTimeout(
      () => finish(undefined, new Error(`等待目标视频解码帧超时（${targetSeconds.toFixed(3)}s）`)),
      timeoutMs,
    );
    requestNextFrame();

    if (restorePaused && !settled) {
      try {
        void Promise.resolve(video.play()).catch((error) => {
          finish(undefined, new Error(`无法临时播放视频以解码目标帧：${errorMessage(error)}`));
        });
      } catch (error) {
        finish(undefined, new Error(`无法临时播放视频以解码目标帧：${errorMessage(error)}`));
      }
    }
  });
}

/**
 * Seeks and returns the media time reported by the decoded target frame.
 * Reliable per-second analysis deliberately has no currentTime/rAF fallback:
 * without requestVideoFrameCallback the caller must stop and report that the
 * browser cannot prove which frame was decoded.
 */
export async function seekVideoFrame(
  video: HTMLVideoElement,
  requestedSeconds: number,
  timeoutMs = 10_000,
): Promise<number> {
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('视频时长无效');
  if (!Number.isFinite(requestedSeconds)) throw new Error('视频目标时间无效');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('视频抽帧超时时间无效');

  const frameAPI = frameCallbackAPI(video);
  if (!frameAPI) {
    throw new Error('当前浏览器不支持 requestVideoFrameCallback，无法进行可靠逐秒视频分析');
  }

  const target = Math.min(Math.max(0, requestedSeconds), Math.max(0, video.duration - 0.05));
  await seekToTarget(video, target, timeoutMs);
  return waitForDecodedTargetFrame(video, frameAPI, target, timeoutMs);
}
