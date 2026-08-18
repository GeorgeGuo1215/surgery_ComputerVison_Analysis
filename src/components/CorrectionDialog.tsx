import { useEffect, useState } from 'react';
import type { VitalKey } from '../domain/types';
import { VITAL_BY_KEY } from '../domain/vitals';

interface CorrectionDialogProps {
  target: { snapshotId: string; key: VitalKey; currentValue: string | null } | null;
  onClose: () => void;
  onSubmit: (value: string, reason: string) => string | null;
}

export function CorrectionDialog({ target, onClose, onSubmit }: CorrectionDialogProps) {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setValue(target?.currentValue ?? '');
    setReason('');
    setError('');
  }, [target]);

  if (!target) return null;
  const definition = VITAL_BY_KEY[target.key];

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="correction-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <div>
            <span className="eyebrow">人工修订 · 保留原值</span>
            <h3 id="correction-title">{definition.label}</h3>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <label className="dialog-field">
          <span>正确读数 <b>{definition.unit}</b></span>
          <input
            autoFocus
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={target.key === 'nibp' ? '120/70 (85)' : '118'}
          />
        </label>
        <label className="dialog-field">
          <span>修订原因 <b>必填</b></span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例：反光导致 OCR 漏读百位" rows={3} />
        </label>
        {error && <p className="field-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button ghost" onClick={onClose}>取消</button>
          <button
            type="button"
            className="button primary"
            onClick={() => {
              if (!reason.trim()) {
                setError('请填写修订原因，以便追溯。');
                return;
              }
              const submitError = onSubmit(value, reason);
              if (submitError) setError(submitError);
            }}
          >
            保存并写入审计记录
          </button>
        </div>
      </section>
    </div>
  );
}
