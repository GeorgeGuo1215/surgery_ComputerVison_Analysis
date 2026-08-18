import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyMedicationState } from '../domain/medications';
import type { MedicationState } from '../domain/types';
import { MedicationPanel } from './MedicationPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function MedicationHarness({
  onExportCSV = vi.fn(),
}: {
  onExportCSV?: () => void;
}) {
  const [value, setValue] = useState<MedicationState>(createEmptyMedicationState());
  return (
    <MedicationPanel
      value={value}
      onChange={setValue}
      onExportCSV={onExportCSV}
      onExportJSON={vi.fn()}
      onExportAuditCSV={vi.fn()}
      now={() => new Date('2026-08-18T02:00:00.000Z')}
    />
  );
}

function addCatalogName(name: string) {
  const input = screen.getByLabelText('自定义药物名称');
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: '加入目录' }));
}

describe('medication panel', () => {
  it('creates, edits, exports, and deletes a multi-drug human-entered record', () => {
    const exportCSV = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MedicationHarness onExportCSV={exportCSV} />);

    expect(screen.getByText(/不预填剂量、不计算剂量/)).toBeInTheDocument();
    expect(screen.getByText(/目录初始为空/)).toBeInTheDocument();
    addCatalogName('医院药物甲');
    addCatalogName('医院药物乙');

    fireEvent.click(screen.getByRole('button', { name: '新建联合用药记录' }));
    expect(screen.getByLabelText('给药时间')).not.toHaveValue('');
    fireEvent.click(screen.getByRole('checkbox', { name: '医院药物甲' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '医院药物乙' }));

    const doseInputs = screen.getAllByLabelText(/剂量文本/);
    expect(doseInputs).toHaveLength(2);
    expect(doseInputs.every((input) => (input as HTMLInputElement).value === '')).toBe(true);

    fireEvent.change(screen.getByLabelText('阶段'), { target: { value: 'induction' } });
    fireEvent.change(screen.getByLabelText('给药时间'), { target: { value: '2026-08-18T10:15' } });
    fireEvent.change(screen.getByLabelText('剂量文本 1'), { target: { value: '人员填写甲' } });
    fireEvent.change(screen.getByLabelText('单位 1'), { target: { value: '单位甲' } });
    fireEvent.change(screen.getByLabelText('途径 1'), { target: { value: '途径甲' } });
    fireEvent.change(screen.getByLabelText('剂量文本 2'), { target: { value: '人员填写乙' } });
    fireEvent.change(screen.getByLabelText('单位 2'), { target: { value: '单位乙' } });
    fireEvent.change(screen.getByLabelText('途径 2'), { target: { value: '途径乙' } });
    fireEvent.click(screen.getByRole('button', { name: '保存联合用药记录' }));

    const eventCard = screen.getByText('人员填写甲 单位甲 · 途径甲').closest('article');
    expect(eventCard).not.toBeNull();
    expect(within(eventCard!).getByText('医院药物甲')).toBeInTheDocument();
    expect(within(eventCard!).getByText('医院药物乙')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByLabelText('剂量文本 1'), { target: { value: '人员复核后甲' } });
    fireEvent.click(screen.getByRole('button', { name: '保存联合用药记录' }));
    expect(screen.getByText('人员复核后甲 单位甲 · 途径甲')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '导出药物 CSV' }));
    expect(exportCSV).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByText('尚无联合用药记录。')).toBeInTheDocument();
    expect(screen.getByText(/5 条审计事件/)).toBeInTheDocument();
  });

  it('does not save an incomplete medication line or invent missing dose fields', () => {
    render(<MedicationHarness />);
    addCatalogName('医院药物甲');
    fireEvent.click(screen.getByRole('button', { name: '新建联合用药记录' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '医院药物甲' }));
    fireEvent.change(screen.getByLabelText('阶段'), { target: { value: 'maintenance' } });
    fireEvent.change(screen.getByLabelText('给药时间'), { target: { value: '2026-08-18T10:15' } });
    fireEvent.click(screen.getByRole('button', { name: '保存联合用药记录' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/剂量文本.*单位.*途径/);
    expect(screen.getByLabelText('剂量文本 1')).toHaveValue('');
    expect(screen.getByText('尚无联合用药记录。')).toBeInTheDocument();
  });
});
