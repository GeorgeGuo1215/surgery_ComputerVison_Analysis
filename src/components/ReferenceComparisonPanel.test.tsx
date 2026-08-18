import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createSnapshot } from '../domain/recording';
import { compareHeartRateSnapshots, parseHeartRateReferenceCSV } from '../domain/referenceComparison';
import { emptyReadingMap } from '../domain/vitals';
import { ReferenceComparisonPanel } from './ReferenceComparisonPanel';

describe('reference comparison panel', () => {
  it('shows provenance warnings, auditable denominators and export actions', () => {
    const dataset = parseHeartRateReferenceCSV(
      'timestamp,video_time_s,raw_value,filtered_value\n2026-08-01 14:23:09.733,0,46,46\n2026-08-01 14:23:10.733,1,4,46',
      'reference.csv',
    );
    const readings = emptyReadingMap('2026-08-01T06:23:09.733Z');
    readings.hr = {
      ...readings.hr,
      display: '46',
      values: [46],
      rawText: '46',
      confidence: 92,
      status: 'ok',
    };
    const record = createSnapshot(readings, 'scheduled', undefined, undefined, {
      inputSource: 'video',
      mediaTimeSeconds: 0,
      sourceFileName: '1.mp4',
    });
    const report = compareHeartRateSnapshots([record], dataset, '1.mp4');
    const exportCSV = vi.fn();

    render(
      <ReferenceComparisonPanel
        dataset={dataset}
        report={report}
        error=""
        disabled={false}
        videoDurationSeconds={1.3}
        alignmentOffsetSeconds={0}
        alignmentToleranceSeconds={0.5}
        onChooseFile={vi.fn()}
        onClear={vi.fn()}
        onOffsetChange={vi.fn()}
        onToleranceChange={vi.fn()}
        onExportCSV={exportCSV}
        onExportJSON={vi.fn()}
      />,
    );

    expect(screen.getByText('HR 参考结果对比')).toBeInTheDocument();
    expect(screen.getByText(/filtered_value（已有算法的滤波结果）/)).toBeInTheDocument();
    expect(screen.getAllByText('1/1 · 100.0%')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: '导出对比 CSV' }));
    expect(exportCSV).toHaveBeenCalledOnce();
  });
});
