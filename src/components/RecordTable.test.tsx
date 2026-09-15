import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RecordTable } from './RecordTable';
import { createSnapshot } from '../domain/recording';
import { emptyReadingMap } from '../domain/vitals';

afterEach(cleanup);

it('bounds rendered rows, preserves historical editing and follows new records', () => {
  const snapshots = Array.from({ length: 102 }, (_, i) => ({
    ...createSnapshot(emptyReadingMap(), 'scheduled'), id: `row-${i}`, note: `note-${i}`,
  }));
  const onNoteChange = vi.fn();
  const props = { snapshots, onNoteChange, onCorrect: vi.fn(), onToggleVerified: vi.fn() };
  const { rerender } = render(<RecordTable {...props} />);
  expect(screen.getAllByPlaceholderText('添加事件 / 备注')).toHaveLength(2);
  expect(screen.getByDisplayValue('note-101')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  expect(screen.getAllByPlaceholderText('添加事件 / 备注')).toHaveLength(50);
  fireEvent.change(screen.getByDisplayValue('note-50'), { target: { value: 'edited' } });
  expect(onNoteChange).toHaveBeenCalledWith('row-50', 'edited');
  expect(snapshots).toHaveLength(102);
  fireEvent.click(screen.getByRole('button', { name: '跟随最新记录' }));
  rerender(<RecordTable {...props} snapshots={[...snapshots, { ...snapshots[0], id: 'row-102', note: 'newest' }]} />);
  expect(screen.getByDisplayValue('newest')).toBeInTheDocument();
  act(() => window.dispatchEvent(new Event('beforeprint')));
  expect(screen.getAllByPlaceholderText('添加事件 / 备注')).toHaveLength(103);
  act(() => window.dispatchEvent(new Event('afterprint')));
  expect(screen.getAllByPlaceholderText('添加事件 / 备注')).toHaveLength(3);
});
