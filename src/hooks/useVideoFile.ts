import { useCallback, useEffect, useRef, useState } from 'react';

export type VideoFileStatus = 'empty' | 'loading' | 'ready' | 'error';

export interface VideoFileMetadata {
  name: string;
  sizeBytes: number;
  type: string;
  lastModified: number;
  durationSeconds: number;
  width: number;
  height: number;
}

interface VideoFileState {
  status: VideoFileStatus;
  sourceUrl: string;
  metadata: VideoFileMetadata | null;
  error: string;
}

const EMPTY_STATE: VideoFileState = {
  status: 'empty',
  sourceUrl: '',
  metadata: null,
  error: '',
};

export function useVideoFile() {
  const [state, setState] = useState<VideoFileState>(EMPTY_STATE);
  const objectUrlRef = useRef('');

  const revokeCurrentUrl = useCallback(() => {
    if (!objectUrlRef.current) return;
    URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = '';
  }, []);

  const clear = useCallback(() => {
    revokeCurrentUrl();
    setState(EMPTY_STATE);
  }, [revokeCurrentUrl]);

  const load = useCallback((file: File) => {
    revokeCurrentUrl();
    const sourceUrl = URL.createObjectURL(file);
    objectUrlRef.current = sourceUrl;
    setState({
      status: 'loading',
      sourceUrl,
      metadata: {
        name: file.name,
        sizeBytes: file.size,
        type: file.type,
        lastModified: file.lastModified,
        durationSeconds: 0,
        width: 0,
        height: 0,
      },
      error: '',
    });
  }, [revokeCurrentUrl]);

  const markReady = useCallback((video: HTMLVideoElement) => {
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) {
      setState((current) => ({ ...current, status: 'error', error: '无法读取有效的视频时长或画面尺寸。' }));
      return;
    }
    setState((current) => {
      if (current.sourceUrl && video.currentSrc && current.sourceUrl !== video.currentSrc) return current;
      return {
        ...current,
        status: 'ready',
        metadata: current.metadata
          ? {
              ...current.metadata,
              durationSeconds: video.duration,
              width: video.videoWidth,
              height: video.videoHeight,
            }
          : null,
        error: '',
      };
    });
  }, []);

  const markError = useCallback((video: HTMLVideoElement) => {
    const mediaError = video.error;
    const detail = mediaError?.message || (mediaError ? `媒体错误代码 ${mediaError.code}` : '浏览器无法解码该视频');
    setState((current) => {
      if (current.sourceUrl && video.currentSrc && current.sourceUrl !== video.currentSrc) return current;
      return {
        ...current,
        status: 'error',
        error: `${detail}。请优先使用 H.264/AAC 编码的 MP4。`,
      };
    });
  }, []);

  useEffect(() => revokeCurrentUrl, [revokeCurrentUrl]);

  return { ...state, load, clear, markReady, markError };
}
