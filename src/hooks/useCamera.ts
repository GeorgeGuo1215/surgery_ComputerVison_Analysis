import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { requestCameraStream } from '../services/camera';

export type CameraStatus =
  | 'idle'
  | 'requesting'
  | 'live'
  | 'denied'
  | 'unavailable'
  | 'interrupted'
  | 'error';

interface UseCameraResult {
  status: CameraStatus;
  error: string;
  devices: MediaDeviceInfo[];
  selectedDeviceId: string;
  activeSettings: MediaTrackSettings | null;
  start: (deviceId?: string) => Promise<boolean>;
  stop: () => void;
  selectDevice: (deviceId: string) => Promise<void>;
}

export function useCamera(videoRef: RefObject<HTMLVideoElement | null>): UseCameraResult {
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [activeSettings, setActiveSettings] = useState<MediaTrackSettings | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const releaseStream = useCallback((stream: MediaStream | null) => {
    stream?.getTracks().forEach((track) => track.stop());
    if (streamRef.current === stream) streamRef.current = null;
    if (videoRef.current?.srcObject === stream) videoRef.current.srcObject = null;
  }, [videoRef]);

  const stop = useCallback(() => {
    requestGenerationRef.current += 1;
    releaseStream(streamRef.current);
    if (videoRef.current) videoRef.current.srcObject = null;
    setActiveSettings(null);
    setStatus('idle');
  }, [releaseStream, videoRef]);

  const refreshDevices = useCallback(async (expectedGeneration?: number) => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      if (
        !mountedRef.current
        || (expectedGeneration != null && requestGenerationRef.current !== expectedGeneration)
      ) return;
      setDevices(allDevices.filter((device) => device.kind === 'videoinput'));
    } catch {
      if (
        !mountedRef.current
        || (expectedGeneration != null && requestGenerationRef.current !== expectedGeneration)
      ) return;
      setDevices([]);
    }
  }, []);

  const start = useCallback(
    async (deviceId?: string) => {
      const generation = requestGenerationRef.current + 1;
      requestGenerationRef.current = generation;
      const isCurrentRequest = () => (
        mountedRef.current && requestGenerationRef.current === generation
      );

      releaseStream(streamRef.current);
      if (videoRef.current) videoRef.current.srcObject = null;
      setActiveSettings(null);

      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        if (isCurrentRequest()) {
          setStatus('unavailable');
          setError('摄像头需要 HTTPS 或 localhost，且浏览器必须支持媒体捕获。');
        }
        return false;
      }

      setStatus('requesting');
      setError('');
      try {
        const stream = await requestCameraStream(navigator.mediaDevices, deviceId);
        if (!isCurrentRequest()) {
          stream.getTracks().forEach((track) => track.stop());
          return false;
        }

        streamRef.current = stream;
        const track = stream.getVideoTracks()[0]!;
        track.addEventListener('ended', () => {
          if (!isCurrentRequest() || streamRef.current !== stream) return;
          setStatus('interrupted');
          setError('摄像头连接已结束，自动记录不会沿用旧值。');
        });
        track.addEventListener('mute', () => {
          if (!isCurrentRequest() || streamRef.current !== stream) return;
          setStatus('interrupted');
          setError('摄像头画面已中断，请检查浏览器或其他应用是否占用镜头。');
        });
        track.addEventListener('unmute', () => {
          if (!isCurrentRequest() || streamRef.current !== stream) return;
          setStatus('live');
          setError('');
        });
        const actualDeviceId = track.getSettings().deviceId ?? deviceId ?? '';
        setSelectedDeviceId(actualDeviceId);
        setActiveSettings(track.getSettings());
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.setAttribute('playsinline', '');
          await videoRef.current.play();
        }

        if (!isCurrentRequest()) {
          releaseStream(stream);
          return false;
        }
        await refreshDevices(generation);
        if (!isCurrentRequest()) {
          releaseStream(stream);
          return false;
        }
        setStatus('live');
        return true;
      } catch (caughtError) {
        if (!isCurrentRequest()) return false;
        releaseStream(streamRef.current);
        const mediaError = caughtError as DOMException;
        const denied = mediaError.name === 'NotAllowedError' || mediaError.name === 'SecurityError';
        setStatus(denied ? 'denied' : 'error');
        setError(
          denied
            ? '未获得摄像头权限。请在浏览器地址栏中允许后重试。'
            : `无法启动摄像头：${mediaError.message || mediaError.name}`,
        );
        return false;
      }
    },
    [refreshDevices, releaseStream, videoRef],
  );

  const selectDevice = useCallback(
    async (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      await start(deviceId);
    },
    [start],
  );

  useEffect(() => {
    if (!navigator.mediaDevices?.addEventListener) return;
    const onDeviceChange = () => void refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange);
  }, [refreshDevices]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      releaseStream(streamRef.current);
    };
  }, [releaseStream]);

  return { status, error, devices, selectedDeviceId, activeSettings, start, stop, selectDevice };
}
