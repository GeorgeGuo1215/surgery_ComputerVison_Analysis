import { useMemo, useState } from 'react';
import {
  MEDICATION_PHASES,
  addMedicationCatalogEntry,
  createMedicationEvent,
  deleteMedicationEvent,
  medicationPhaseLabel,
  removeMedicationCatalogEntry,
  updateMedicationEvent,
  validateMedicationEventInput,
} from '../domain/medications';
import type {
  MedicationLineInput,
  MedicationMutationOptions,
} from '../domain/medications';
import type {
  MedicationCatalogEntry,
  MedicationEvent,
  MedicationPhase,
  MedicationState,
} from '../domain/types';

export interface MedicationPanelProps {
  value: MedicationState;
  onChange: (next: MedicationState) => void;
  disabled?: boolean;
  onExportCSV?: () => void;
  onExportJSON?: () => void;
  onExportAuditCSV?: () => void;
  now?: () => Date;
  makeId?: MedicationMutationOptions['makeId'];
}

interface MedicationDraft {
  eventId: string | null;
  phase: MedicationPhase | '';
  phaseDetail: string;
  administeredAt: string;
  medications: MedicationLineInput[];
  note: string;
}

let draftCounter = 0;

function draftLineId(): string {
  draftCounter += 1;
  return `medication-line-draft-${draftCounter}`;
}

function emptyDraft(currentTime: Date): MedicationDraft {
  return {
    eventId: null,
    phase: '',
    phaseDetail: '',
    administeredAt: toDateTimeLocal(currentTime.toISOString()),
    medications: [],
    note: '',
  };
}

function toDateTimeLocal(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function eventDraft(event: MedicationEvent): MedicationDraft {
  return {
    eventId: event.id,
    phase: event.phase,
    phaseDetail: event.phaseDetail,
    administeredAt: toDateTimeLocal(event.administeredAt),
    medications: event.medications.map((line) => ({ ...line })),
    note: event.note,
  };
}

function formatTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (!Number.isFinite(date.getTime())) return isoTimestamp;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function MedicationPanel({
  value,
  onChange,
  disabled = false,
  onExportCSV,
  onExportJSON,
  onExportAuditCSV,
  now = () => new Date(),
  makeId,
}: MedicationPanelProps) {
  const [customName, setCustomName] = useState('');
  const [draft, setDraft] = useState<MedicationDraft | null>(null);
  const [error, setError] = useState('');
  const mutationOptions = (): MedicationMutationOptions => ({
    changedAt: now().toISOString(),
    makeId,
  });
  const sortedCatalog = useMemo(
    () => [...value.catalog].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    [value.catalog],
  );

  const reportError = (caught: unknown) => {
    setError(caught instanceof Error ? caught.message : String(caught));
  };

  const addCatalog = () => {
    try {
      const next = addMedicationCatalogEntry(value, customName, mutationOptions());
      onChange(next);
      setCustomName('');
      setError('');
    } catch (caught) {
      reportError(caught);
    }
  };

  const removeCatalog = (entry: MedicationCatalogEntry) => {
    if (!window.confirm(`从医院药物目录移除“${entry.name}”？已有记录仍保留当时填写的名称。`)) return;
    try {
      onChange(removeMedicationCatalogEntry(value, entry.id, mutationOptions()));
      setDraft((current) => current == null ? null : ({
        ...current,
        medications: current.medications.filter(({ catalogEntryId }) => catalogEntryId !== entry.id),
      }));
      setError('');
    } catch (caught) {
      reportError(caught);
    }
  };

  const toggleCatalogEntry = (entry: MedicationCatalogEntry) => {
    setDraft((current) => {
      if (!current) return current;
      const selected = current.medications.some(({ catalogEntryId }) => catalogEntryId === entry.id);
      return {
        ...current,
        medications: selected
          ? current.medications.filter(({ catalogEntryId }) => catalogEntryId !== entry.id)
          : [...current.medications, {
            id: draftLineId(),
            catalogEntryId: entry.id,
            name: entry.name,
            doseText: '',
            unit: '',
            route: '',
            note: '',
          }],
      };
    });
    setError('');
  };

  const updateLine = (lineId: string, patch: Partial<MedicationLineInput>) => {
    setDraft((current) => current == null ? null : ({
      ...current,
      medications: current.medications.map((line) => line.id === lineId ? { ...line, ...patch } : line),
    }));
  };

  const removeLine = (lineId: string) => {
    setDraft((current) => current == null ? null : ({
      ...current,
      medications: current.medications.filter((line) => line.id !== lineId),
    }));
  };

  const saveDraft = () => {
    if (!draft) return;
    if (!draft.phase) {
      setError('请选择给药阶段。');
      return;
    }
    const administeredDate = new Date(draft.administeredAt);
    const input = {
      phase: draft.phase,
      phaseDetail: draft.phaseDetail,
      administeredAt: Number.isFinite(administeredDate.getTime()) ? administeredDate.toISOString() : draft.administeredAt,
      medications: draft.medications,
      note: draft.note,
    };
    const validationErrors = validateMedicationEventInput(input);
    if (validationErrors.length > 0) {
      setError(validationErrors.join(' '));
      return;
    }
    try {
      const next = draft.eventId
        ? updateMedicationEvent(value, draft.eventId, input, mutationOptions())
        : createMedicationEvent(value, input, mutationOptions());
      onChange(next);
      setDraft(null);
      setError('');
    } catch (caught) {
      reportError(caught);
    }
  };

  const deleteEvent = (event: MedicationEvent) => {
    if (!window.confirm(`删除 ${formatTime(event.administeredAt)} 的联合用药记录？删除动作会保留在审计轨迹中。`)) return;
    try {
      onChange(deleteMedicationEvent(value, event.id, mutationOptions()));
      if (draft?.eventId === event.id) setDraft(null);
      setError('');
    } catch (caught) {
      reportError(caught);
    }
  };

  return (
    <section className="medication-panel section-card" aria-labelledby="medication-panel-title">
      <div className="section-heading medication-panel-heading">
        <div>
          <span className="eyebrow">HUMAN-ENTERED MEDICATION LOG</span>
          <h2 id="medication-panel-title">联合用药选择与记录</h2>
          <p>仅保存人员填写的给药事实；系统不预填剂量、不计算剂量，也不提供用药或临床建议。</p>
        </div>
        <button type="button" className="button primary" disabled={disabled || draft != null} onClick={() => setDraft(emptyDraft(now()))}>
          新建联合用药记录
        </button>
      </div>

      <aside className="medication-safety-note" role="note">
        <strong>请逐项人工核对。</strong>
        <span>药名、剂量文本、单位、途径、阶段与时间均由人员填写；空白字段不会被自动补全。</span>
      </aside>

      <section className="medication-catalog" aria-labelledby="medication-catalog-title">
        <div className="medication-subheading">
          <div>
            <h3 id="medication-catalog-title">医院药物目录</h3>
            <p>目录初始为空，仅保存本院自行添加的名称，不附带剂量或推荐。</p>
          </div>
          <div className="medication-catalog-add">
            <label>
              <span>自定义药物名称</span>
              <input
                value={customName}
                disabled={disabled}
                onChange={(event) => setCustomName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addCatalog();
                  }
                }}
              />
            </label>
            <button type="button" className="button ghost" disabled={disabled || !customName.trim()} onClick={addCatalog}>加入目录</button>
          </div>
        </div>
        {sortedCatalog.length === 0 ? (
          <p className="medication-empty">尚未添加医院药物名称。</p>
        ) : (
          <ul className="medication-catalog-list">
            {sortedCatalog.map((entry) => (
              <li key={entry.id}>
                <span>{entry.name}</span>
                <button type="button" className="icon-button" disabled={disabled} aria-label={`移除目录药物 ${entry.name}`} onClick={() => removeCatalog(entry)}>×</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {draft && (
        <section className="medication-editor" aria-labelledby="medication-editor-title">
          <div className="medication-subheading">
            <h3 id="medication-editor-title">{draft.eventId ? '编辑联合用药记录' : '新建联合用药记录'}</h3>
            <span>{draft.medications.length} 种药物</span>
          </div>

          <div className="medication-event-fields">
            <label>
              <span>阶段</span>
              <select
                value={draft.phase}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, phase: event.target.value as MedicationPhase | '' })}
              >
                <option value="">请选择</option>
                {MEDICATION_PHASES.map(({ value: phase, label }) => <option key={phase} value={phase}>{label}</option>)}
              </select>
            </label>
            {draft.phase === 'other' && (
              <label>
                <span>其他阶段名称</span>
                <input value={draft.phaseDetail} disabled={disabled} onChange={(event) => setDraft({ ...draft, phaseDetail: event.target.value })} />
              </label>
            )}
            <label>
              <span>给药时间</span>
              <input
                type="datetime-local"
                value={draft.administeredAt}
                disabled={disabled}
                onChange={(event) => setDraft({ ...draft, administeredAt: event.target.value })}
              />
            </label>
            <label>
              <span>组合备注</span>
              <input value={draft.note} disabled={disabled} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
            </label>
          </div>

          <fieldset className="medication-multi-select" disabled={disabled || sortedCatalog.length === 0}>
            <legend>从医院目录多选本次组合</legend>
            {sortedCatalog.length === 0
              ? <p>请先添加医院药物名称。</p>
              : sortedCatalog.map((entry) => (
                <label key={entry.id}>
                  <input
                    type="checkbox"
                    checked={draft.medications.some(({ catalogEntryId }) => catalogEntryId === entry.id)}
                    onChange={() => toggleCatalogEntry(entry)}
                  />
                  <span>{entry.name}</span>
                </label>
              ))}
          </fieldset>

          <div className="medication-lines">
            {draft.medications.map((line, index) => (
              <article className="medication-line" key={line.id}>
                <div className="medication-line-heading">
                  <strong>药物 {index + 1}</strong>
                  <button type="button" className="button ghost" disabled={disabled} onClick={() => removeLine(line.id ?? '')}>移出组合</button>
                </div>
                <div className="medication-line-fields">
                  <label>
                    <span>药物名称</span>
                    <input aria-label={`药物名称 ${index + 1}`} value={line.name} disabled={disabled} onChange={(event) => updateLine(line.id ?? '', { name: event.target.value })} />
                  </label>
                  <label>
                    <span>剂量文本</span>
                    <input aria-label={`剂量文本 ${index + 1}`} value={line.doseText} disabled={disabled} placeholder="由人员填写" onChange={(event) => updateLine(line.id ?? '', { doseText: event.target.value })} />
                  </label>
                  <label>
                    <span>单位</span>
                    <input aria-label={`单位 ${index + 1}`} value={line.unit} disabled={disabled} onChange={(event) => updateLine(line.id ?? '', { unit: event.target.value })} />
                  </label>
                  <label>
                    <span>途径</span>
                    <input aria-label={`途径 ${index + 1}`} value={line.route} disabled={disabled} onChange={(event) => updateLine(line.id ?? '', { route: event.target.value })} />
                  </label>
                  <label>
                    <span>备注</span>
                    <input aria-label={`药物备注 ${index + 1}`} value={line.note ?? ''} disabled={disabled} onChange={(event) => updateLine(line.id ?? '', { note: event.target.value })} />
                  </label>
                </div>
              </article>
            ))}
          </div>

          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="medication-editor-actions">
            <button type="button" className="button ghost" disabled={disabled} onClick={() => { setDraft(null); setError(''); }}>取消</button>
            <button type="button" className="button primary" disabled={disabled} onClick={saveDraft}>保存联合用药记录</button>
          </div>
        </section>
      )}

      {!draft && error && <p className="field-error" role="alert">{error}</p>}

      <section className="medication-event-list" aria-labelledby="medication-event-list-title">
        <div className="medication-subheading">
          <div>
            <h3 id="medication-event-list-title">已记录事件</h3>
            <p>{value.events.length} 条记录 · {value.audit.length} 条审计事件</p>
          </div>
          <div className="medication-export-actions">
            {onExportAuditCSV && <button type="button" className="button ghost" disabled={disabled} onClick={onExportAuditCSV}>导出审计 CSV</button>}
            {onExportJSON && <button type="button" className="button ghost" disabled={disabled} onClick={onExportJSON}>导出药物 JSON</button>}
            {onExportCSV && <button type="button" className="button primary" disabled={disabled} onClick={onExportCSV}>导出药物 CSV</button>}
          </div>
        </div>

        {value.events.length === 0 ? (
          <p className="medication-empty">尚无联合用药记录。</p>
        ) : (
          <div className="medication-event-cards">
            {value.events.map((event) => (
              <article className="medication-event-card" key={event.id}>
                <div className="medication-event-summary">
                  <div>
                    <span>{medicationPhaseLabel(event.phase, event.phaseDetail)}</span>
                    <strong>{formatTime(event.administeredAt)}</strong>
                  </div>
                  <div>
                    <button type="button" className="button ghost" disabled={disabled || draft != null} onClick={() => { setDraft(eventDraft(event)); setError(''); }}>编辑</button>
                    <button type="button" className="button ghost danger" disabled={disabled} onClick={() => deleteEvent(event)}>删除</button>
                  </div>
                </div>
                <ul>
                  {event.medications.map((line) => (
                    <li key={line.id}>
                      <strong>{line.name}</strong>
                      <span>{line.doseText} {line.unit} · {line.route}</span>
                      {line.note && <small>{line.note}</small>}
                    </li>
                  ))}
                </ul>
                {event.note && <p>{event.note}</p>}
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
