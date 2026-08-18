import { formatMediaTime } from '../domain/offline';
import type {
  HeartRateComparisonReport,
  HeartRateComparisonResult,
  HeartRateReferenceDataset,
  HeartRateReferenceSample,
} from '../domain/referenceComparison';

interface ReferenceComparisonPanelProps {
  dataset: HeartRateReferenceDataset | null;
  report: HeartRateComparisonReport | null;
  error: string;
  disabled: boolean;
  videoDurationSeconds: number | null;
  alignmentOffsetSeconds: number;
  alignmentToleranceSeconds: number;
  onChooseFile: () => void;
  onClear: () => void;
  onOffsetChange: (value: number) => void;
  onToleranceChange: (value: number) => void;
  onExportCSV: () => void;
  onExportJSON: () => void;
}

const RESULT_LABELS: Record<HeartRateComparisonResult, string> = {
  exact: '完全一致',
  'within-2': '误差 ±2',
  mismatch: '超出 ±2',
  'needs-review': 'OCR 待复核',
  'ocr-rejected': 'OCR 拒识',
  'manual-excluded': '人工修订排除',
  'derived-reference-excluded': '派生参考排除',
  'invalid-reference': '参考值无效',
  'no-reference': '无参考点',
};

const PROVENANCE_LABELS: Record<HeartRateReferenceSample['provenance'], string> = {
  'direct-raw-match': '原始/过滤一致',
  'filtered-or-derived': '滤波派生',
  'provided-ground-truth': '提供的人工标注',
  'provided-unverified': '未验证参考',
  invalid: '超范围',
  missing: '空值',
};

function metric(value: number | null, suffix = ''): string {
  return value == null ? '—' : `${value.toFixed(1)}${suffix}`;
}

function ratio(count: number, total: number, percent: number | null): string {
  return `${count}/${total}${percent == null ? '' : ` · ${percent.toFixed(1)}%`}`;
}

export function ReferenceComparisonPanel({
  dataset,
  report,
  error,
  disabled,
  videoDurationSeconds,
  alignmentOffsetSeconds,
  alignmentToleranceSeconds,
  onChooseFile,
  onClear,
  onOffsetChange,
  onToleranceChange,
  onExportCSV,
  onExportJSON,
}: ReferenceComparisonPanelProps) {
  const coverageDelta = dataset && videoDurationSeconds != null
    ? Math.abs(videoDurationSeconds - dataset.lastVideoTimeSeconds)
    : null;
  const coverageMatches = coverageDelta != null && coverageDelta <= Math.max(1, (dataset?.cadenceSeconds ?? 1) * 1.1);
  const summary = report?.summary;
  const fullPerSecondComparison = Boolean(
    dataset
    && report
    && dataset.cadenceSeconds === 1
    && report.rows.length === dataset.samples.length,
  );

  return (
    <section className="reference-section section-card" aria-labelledby="reference-comparison-title">
      <div className="section-heading reference-heading">
        <div>
          <span className="eyebrow">ENGINEERING REFERENCE · HR</span>
          <h2 id="reference-comparison-title">HR 参考结果对比</h2>
          <p>按视频相对秒对齐新 OCR 与参考 CSV；人工修订和滤波补值不计入主指标。</p>
        </div>
        <div className="reference-actions">
          <button type="button" className="button ghost" disabled={disabled} onClick={onChooseFile}>
            {dataset ? '更换参考 CSV' : '导入参考 CSV'}
          </button>
          {dataset && <button type="button" className="button ghost" disabled={disabled} onClick={onClear}>移除</button>}
        </div>
      </div>

      {error && <p className="reference-error" role="alert">{error}</p>}

      {!dataset ? (
        <button type="button" className="reference-empty" disabled={disabled} onClick={onChooseFile}>
          <strong>选择带 video_time_s 和 HR 参考列的 CSV</strong>
          <span>可识别 filtered_value、ground_truth、reference_value、heart_rate 或 hr；文件仅在本机解析。</span>
        </button>
      ) : (
        <>
          <div className="reference-file-card">
            <div>
              <strong>{dataset.fileName}</strong>
              <span>{dataset.samples.length} 个参考点 · {formatMediaTime(dataset.firstVideoTimeSeconds)}–{formatMediaTime(dataset.lastVideoTimeSeconds)} · 列 {dataset.sourceColumn}</span>
            </div>
            <dl>
              <div><dt>采样</dt><dd>{dataset.cadenceSeconds == null ? '不规则' : `${dataset.cadenceSeconds.toFixed(3)} s`}</dd></div>
              <div><dt>主指标候选</dt><dd>{dataset.primaryEligibleCount}</dd></div>
              <div><dt>滤波派生</dt><dd>{dataset.derivedReferenceCount}</dd></div>
              <div><dt>与视频末尾</dt><dd>{coverageDelta == null ? '等待视频' : `${coverageMatches ? '匹配' : '需核对'} · 差 ${coverageDelta.toFixed(3)} s`}</dd></div>
            </dl>
          </div>

          <aside className="reference-warning" role="note">
            <strong>这是工程一致性对比，不是临床准确率结论。</strong>
            {dataset.warnings.map((warning) => <span key={warning}>{warning}</span>)}
          </aside>

          <div className="reference-settings">
            <label>
              <span>CSV 时间修正</span>
              <input
                type="number"
                step="0.1"
                value={alignmentOffsetSeconds}
                disabled={disabled}
                onChange={(event) => onOffsetChange(Number(event.target.value))}
              />
              <small>匹配 CSV 时间 ≈ 视频时间 + 修正秒数</small>
            </label>
            <label>
              <span>最大对齐容差</span>
              <input
                type="number"
                min="0.01"
                max="10"
                step="0.05"
                value={alignmentToleranceSeconds}
                disabled={disabled}
                onChange={(event) => onToleranceChange(Number(event.target.value))}
              />
              <small>本文件 1 秒采样时建议 ±0.50 秒</small>
            </label>
          </div>

          {!report || report.rows.length === 0 || !summary ? (
            <p className="reference-pending">参考时间轴已就绪。选择“1 秒（HR 逐秒对比）”可生成对应全部参考秒点；其他间隔只做稀疏抽样。</p>
          ) : (
            <>
              <div className="comparison-metrics" aria-label="HR 对比汇总">
                <div><span>时间对齐</span><strong>{summary.alignedCount}/{summary.snapshotCount}</strong><small>当前视频 OCR 时间点</small></div>
                <div><span>主指标参考点</span><strong>{summary.eligibleReferenceCount}</strong><small>已排除派生 {summary.derivedReferenceExcludedCount}</small></div>
                <div><span>完全一致覆盖</span><strong>{ratio(summary.exactAcceptedCount, summary.eligibleReferenceCount, summary.exactCoveragePercent)}</strong><small>分母含 OCR 拒识</small></div>
                <div><span>±2 bpm 覆盖</span><strong>{ratio(summary.withinTwoAcceptedCount, summary.eligibleReferenceCount, summary.withinTwoCoveragePercent)}</strong><small>自动接受且误差不超过 2</small></div>
                <div><span>±5 bpm 覆盖</span><strong>{ratio(summary.withinFiveAcceptedCount, summary.eligibleReferenceCount, summary.withinFiveCoveragePercent)}</strong><small>自动接受且误差不超过 5</small></div>
                <div><span>MAE / RMSE</span><strong>{metric(summary.meanAbsoluteErrorBpm)} / {metric(summary.rootMeanSquareErrorBpm)}</strong><small>bpm · 仅主指标配对</small></div>
                <div><span>平均偏差 / 最大误差</span><strong>{metric(summary.meanBiasBpm)} / {metric(summary.maximumAbsoluteErrorBpm)}</strong><small>bpm · OCR 减参考</small></div>
                <div><span>拒识 / 待复核</span><strong>{summary.rejectedCount} / {summary.reviewCount}</strong><small>不会沿用上一值</small></div>
              </div>

              <div className="reference-export-actions">
                <p>{fullPerSecondComparison
                  ? `已生成 ${report.rows.length} 个逐秒 HR OCR 时间点；时间对齐不等于数值正确，也不是临床准确率。`
                  : `正在比较 ${report.rows.length} 个离线抽样点，不是 CSV 全部 ${dataset.samples.length} 行的逐秒准确率。`}</p>
                <div>
                  <button type="button" className="button ghost" onClick={onExportJSON}>JSON 审计</button>
                  <button type="button" className="button primary" onClick={onExportCSV}>导出对比 CSV</button>
                </div>
              </div>

              <div className="comparison-table-wrap">
                <table className="comparison-table">
                  <thead><tr><th>视频时间</th><th>新 OCR HR</th><th>参考 HR</th><th>参考质量</th><th>误差</th><th>结果</th></tr></thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={row.snapshotId}>
                        <td><strong>{formatMediaTime(row.videoTimeSeconds)}</strong><small>对齐 Δ {row.alignmentDeltaSeconds == null ? '—' : `${row.alignmentDeltaSeconds.toFixed(3)}s`}</small></td>
                        <td><strong>{row.ocrDisplay ?? '—'}</strong><small>{row.ocrStatus} · {Math.round(row.ocrConfidence)}%</small></td>
                        <td><strong>{row.referenceValue ?? '—'}</strong><small>原始 {row.referenceRawValue ?? '—'} · 行 {row.referenceRowNumber ?? '—'}</small></td>
                        <td>{row.referenceProvenance ? PROVENANCE_LABELS[row.referenceProvenance] : '—'}</td>
                        <td>{row.differenceBpm == null ? '—' : `${row.differenceBpm > 0 ? '+' : ''}${row.differenceBpm} bpm`}</td>
                        <td><span className={`comparison-result is-${row.result}`}>{RESULT_LABELS[row.result]}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
