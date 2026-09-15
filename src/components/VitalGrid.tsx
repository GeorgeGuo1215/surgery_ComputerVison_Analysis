import type { ReadingMap, VitalKey, VitalReading } from '../domain/types';
import { ACTIVE_VITAL_DEFINITIONS, isAcceptedVitalReading } from '../domain/vitals';

interface VitalGridProps {
  readings: ReadingMap;
  history: Record<VitalKey, VitalReading[]>;
  onCalibrate: (key: VitalKey) => void;
}

function Sparkline({ readings, color }: { readings: VitalReading[]; color: string }) {
  const values = readings
    .filter((reading) => (
      isAcceptedVitalReading(reading)
    ))
    .slice(-18)
    .map((reading) => reading.values[0]);
  if (values.length < 2) return <span className="sparkline-empty">AWAITING SIGNAL</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${28 - ((value - min) / range) * 22}`)
    .join(' ');
  return (
    <svg className="sparkline" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const statusText = {
  ok: '可记录',
  'manual-corrected': '人工修订',
  'low-confidence': '待核对',
  'out-of-range': '范围异常',
  'not-found': '未识别',
  'not-configured': '未配置',
};

export function VitalGrid({ readings, history, onCalibrate }: VitalGridProps) {
  return (
    <div className="vital-grid is-hr-rr">
      {ACTIVE_VITAL_DEFINITIONS.map((definition) => {
        const reading = readings[definition.key];
        const reliable = isAcceptedVitalReading(reading);
        return (
          <article className={`vital-card status-${reading.status}`} key={definition.key} style={{ '--metric-color': definition.color } as React.CSSProperties}>
            <div className="vital-card-head">
              <div>
                <span className="metric-dot" />
                <strong>{definition.shortLabel}</strong>
                <small>{definition.label}</small>
              </div>
              <button type="button" className="icon-button" onClick={() => onCalibrate(definition.key)} title="重新框选 ROI">
                ⌗
              </button>
            </div>
            <div className="vital-value-row">
              <span className="vital-value">{reading.display ?? '—'}</span>
              <span className="vital-unit">{definition.unit}</span>
            </div>
            <Sparkline readings={history[definition.key]} color={definition.color} />
            <div className="vital-meta">
              <span className={`reading-state ${reliable ? 'is-ok' : ''}`}>{statusText[reading.status]}</span>
              <span>{reading.confidence > 0 ? `${Math.round(reading.confidence)}%` : '—'}</span>
            </div>
            {reading.reason && <p className="vital-reason">{reading.reason}</p>}
          </article>
        );
      })}
    </div>
  );
}
