import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import type { RecordSnapshot, VitalKey } from '../domain/types';
import { formatMediaTime } from '../domain/offline';
import { ACTIVE_VITAL_DEFINITIONS, isAcceptedHeartRateReading } from '../domain/vitals';

interface RecordTableProps {
  snapshots: RecordSnapshot[];
  onToggleVerified: (id: string) => void;
  onNoteChange: (id: string, note: string) => void;
  onCorrect: (id: string, key: VitalKey) => void;
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
function formatTime(iso: string) {
  return timeFormatter.format(new Date(iso));
}

const qualityLabels = {
  complete: '完整',
  review: '待核对',
  missing: '缺失',
};

export function RecordTable({ snapshots, onToggleVerified, onNoteChange, onCorrect }: RecordTableProps) {
  const pageSize = 50;
  const [selectedPage, setSelectedPage] = useState<number | null>(null);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
  const lastPage = Math.max(0, Math.ceil(snapshots.length / pageSize) - 1);
  const page = selectedPage == null ? lastPage : Math.min(selectedPage, lastPage);
  const visibleSnapshots = printing ? snapshots : snapshots.slice(page * pageSize, (page + 1) * pageSize);
  return (
    <div className="table-wrap">
      {snapshots.length > pageSize && <nav className="record-pagination" aria-label="记录分页">
        <span>共 {snapshots.length} 行 · 第 {page + 1}/{lastPage + 1} 页 · 每页 {pageSize} 行（导出包含全部记录）</span>
        <button type="button" className="button ghost" disabled={page === 0} onClick={() => setSelectedPage(page - 1)}>上一页</button>
        <button type="button" className="button ghost" disabled={page === lastPage} onClick={() => setSelectedPage(page + 1)}>下一页</button>
        <button type="button" className="button ghost" disabled={selectedPage == null} onClick={() => setSelectedPage(null)}>跟随最新记录</button>
      </nav>}
      <table className="record-table">
        <thead>
          <tr>
            <th>计划 / 视频时间</th>
            <th>方式</th>
            {ACTIVE_VITAL_DEFINITIONS.map(({ key, shortLabel, unit }) => (
              <th key={key}>
                {shortLabel}<small>{unit}</small>
              </th>
            ))}
            <th>质量</th>
            <th>人工核对</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.length === 0 ? (
            <tr>
              <td colSpan={ACTIVE_VITAL_DEFINITIONS.length + 5}>
                <div className="empty-table">
                  <span>00:00</span>
                  <strong>尚无记录</strong>
                  <p>开始监测，或导入视频进行离线分析后生成记录。</p>
                </div>
              </td>
            </tr>
          ) : (
            visibleSnapshots.map((snapshot) => (
              <tr key={snapshot.id}>
                <td className="time-cell">
                  <strong>{snapshot.mediaTimeSeconds == null ? formatTime(snapshot.scheduledAt) : `视频 ${formatMediaTime(snapshot.mediaTimeSeconds)}`}</strong>
                  <small>
                    {snapshot.inputSource === 'video'
                      ? snapshot.videoStartAt
                        ? `${formatTime(snapshot.scheduledAt)} 对应时间`
                        : `${formatTime(snapshot.analyzedAt ?? snapshot.recordedAt)} 分析`
                      : `${formatTime(snapshot.recordedAt)} 实际`}
                  </small>
                </td>
                <td>
                  <span className="source-pill">
                    {snapshot.inputSource === 'video' ? '视频导入' : snapshot.source === 'scheduled' ? '自动' : '手动'}
                  </span>
                </td>
                {ACTIVE_VITAL_DEFINITIONS.map(({ key }) => {
                  const reading = snapshot.readings[key];
                  const reliable = key === 'hr'
                    ? isAcceptedHeartRateReading(reading)
                    : reading.status === 'ok' || reading.status === 'manual-corrected';
                  return (
                    <td key={key}>
                      <button
                        type="button"
                        className={`table-reading status-${reading.status}`}
                        onClick={() => onCorrect(snapshot.id, key)}
                        title={reading.reason ?? '点击人工修订'}
                      >
                        <span>{reading.display ?? '—'}</span>
                        <small>{reliable && reading.status === 'manual-corrected'
                          ? '已修订'
                          : reliable && reading.status === 'ok'
                            ? `${Math.round(reading.confidence)}%`
                            : reading.display != null
                              ? `候选 · ${Math.round(reading.confidence)}%`
                              : '未识别'}</small>
                      </button>
                    </td>
                  );
                })}
                <td><span className={`quality-pill is-${snapshot.quality}`}>{qualityLabels[snapshot.quality]}</span></td>
                <td>
                  <label className="verify-check">
                    <input type="checkbox" checked={snapshot.verified} onChange={() => onToggleVerified(snapshot.id)} />
                    <span>{snapshot.verified ? '已核对' : '待核对'}</span>
                  </label>
                </td>
                <td>
                  <input
                    className="note-input"
                    value={snapshot.note}
                    placeholder="添加事件 / 备注"
                    onChange={(event) => onNoteChange(snapshot.id, event.target.value)}
                  />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
