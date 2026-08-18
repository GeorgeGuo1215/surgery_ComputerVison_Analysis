import { useRef, useState, type PointerEvent, type RefObject } from 'react';
import type { CaptureMode, NormalizedROI, ReadingMap, VitalKey } from '../domain/types';
import { ACTIVE_VITAL_DEFINITIONS, VITAL_BY_KEY, isAcceptedHeartRateReading } from '../domain/vitals';
import type { CameraStatus } from '../hooks/useCamera';
import { DemoMonitor } from './DemoMonitor';

interface MonitorStageProps {
  mode: CaptureMode;
  videoRef: RefObject<HTMLVideoElement | null>;
  demoCanvasRef: RefObject<HTMLCanvasElement | null>;
  readings: ReadingMap;
  rois: Record<VitalKey, NormalizedROI | null>;
  selectedROI: VitalKey | null;
  cameraStatus: CameraStatus;
  ocrLabel: string;
  videoSourceUrl?: string;
  mediaAspectRatio?: number;
  analysisLocked?: boolean;
  onVideoReady?: (video: HTMLVideoElement) => void;
  onVideoError?: (video: HTMLVideoElement) => void;
  onSelectROI: (key: VitalKey | null) => void;
  onROIChange: (key: VitalKey, roi: NormalizedROI) => void;
}

export function MonitorStage({
  mode,
  videoRef,
  demoCanvasRef,
  readings,
  rois,
  selectedROI,
  cameraStatus,
  ocrLabel,
  videoSourceUrl,
  mediaAspectRatio = 16 / 9,
  analysisLocked = false,
  onVideoReady,
  onVideoError,
  onSelectROI,
  onROIChange,
}: MonitorStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<NormalizedROI | null>(null);

  const pointerPosition = (event: PointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!selectedROI || mode === 'idle' || analysisLocked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = pointerPosition(event);
    setDragStart(start);
    setDraft({ x: start.x, y: start.y, width: 0, height: 0 });
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart || !selectedROI) return;
    const current = pointerPosition(event);
    setDraft({
      x: Math.min(dragStart.x, current.x),
      y: Math.min(dragStart.y, current.y),
      width: Math.abs(current.x - dragStart.x),
      height: Math.abs(current.y - dragStart.y),
    });
  };

  const finishDrag = () => {
    if (selectedROI && draft && draft.width >= 0.025 && draft.height >= 0.025) {
      onROIChange(selectedROI, draft);
      onSelectROI(null);
    }
    setDragStart(null);
    setDraft(null);
  };

  const shownROIs = selectedROI && draft ? { ...rois, [selectedROI]: draft } : rois;

  return (
    <section className="monitor-shell" aria-label="监护仪画面">
      <div className="monitor-toolbar">
        <div>
          <span className={`live-dot ${mode === 'camera' && cameraStatus === 'live' ? 'is-live' : mode === 'video' ? 'is-video' : mode === 'demo' ? 'is-demo' : ''}`} />
          <strong>{mode === 'camera' ? '实时摄像头' : mode === 'video' ? '本地离线视频' : mode === 'demo' ? '演示信号' : '等待视频源'}</strong>
        </div>
        <span className="ocr-status">{ocrLabel}</span>
      </div>

      <div className="monitor-viewport">
        <div
          ref={stageRef}
          className={`monitor-stage ${mediaAspectRatio < 1 ? 'is-portrait' : ''} ${selectedROI ? 'is-calibrating' : ''}`}
          style={{
            aspectRatio: String(mediaAspectRatio),
            maxWidth: mediaAspectRatio < 1 ? `min(100%, ${Math.round(mediaAspectRatio * 70)}dvh)` : undefined,
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
        >
          <video
            ref={videoRef}
            className={`monitor-media ${mode === 'camera' || mode === 'video' ? '' : 'is-hidden'}`}
            src={mode === 'video' ? videoSourceUrl : undefined}
            playsInline
            muted
            controls={mode === 'video' && !analysisLocked && !selectedROI}
            preload="metadata"
            disablePictureInPicture
            aria-label={mode === 'video' ? '离线监护仪视频' : '摄像头实时画面'}
            onLoadedMetadata={(event) => onVideoReady?.(event.currentTarget)}
            onLoadedData={(event) => onVideoReady?.(event.currentTarget)}
            onResize={(event) => onVideoReady?.(event.currentTarget)}
            onError={(event) => onVideoError?.(event.currentTarget)}
          />
          {mode === 'demo' ? (
            <DemoMonitor canvasRef={demoCanvasRef} readings={readings} />
          ) : mode === 'idle' ? (
            <div className="monitor-placeholder">
              <div className="placeholder-reticle" aria-hidden="true" />
              <strong>将镜头对准监护仪屏幕</strong>
              <span>可使用摄像头，或导入本地监护仪视频</span>
            </div>
          ) : null}

          {mode !== 'idle' &&
            ACTIVE_VITAL_DEFINITIONS.map(({ key, shortLabel, color }) => {
              const roi = shownROIs[key];
              if (!roi) return null;
              const reading = readings[key];
              return (
                <button
                  type="button"
                  key={key}
                  disabled={analysisLocked}
                  className={`roi-box ${selectedROI === key ? 'is-selected' : ''} ${(key === 'hr'
                    ? isAcceptedHeartRateReading(reading)
                    : reading.status === 'ok' || reading.status === 'manual-corrected')
                    ? 'is-recognized'
                    : ''}`}
                  style={{
                    left: `${roi.x * 100}%`,
                    top: `${roi.y * 100}%`,
                    width: `${roi.width * 100}%`,
                    height: `${roi.height * 100}%`,
                    '--roi-color': color,
                  } as React.CSSProperties}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectROI(key);
                  }}
                  aria-pressed={selectedROI === key}
                  aria-label={`调整 ${VITAL_BY_KEY[key].label} 识别区域`}
                >
                  <span>{shortLabel}</span>
                  {reading.display && <b>{reading.display}</b>}
                </button>
              );
            })}

          {selectedROI && !analysisLocked && (
            <div className="calibration-hint">
              拖动框选 <strong>{VITAL_BY_KEY[selectedROI].label}</strong> 数字
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
