import type { CaseMetadata } from '../domain/types';

interface CaseSetupProps {
  metadata: CaseMetadata;
  onChange: (metadata: CaseMetadata) => void;
}

const fields: Array<{ key: keyof CaseMetadata; label: string; placeholder: string }> = [
  { key: 'caseId', label: '病例号', placeholder: 'OR-2026-001' },
  { key: 'patientName', label: '动物姓名', placeholder: '例：豆豆' },
  { key: 'species', label: '物种 / 品种', placeholder: '例：犬 · 贵宾' },
  { key: 'weight', label: '体重', placeholder: '例：6.2 kg' },
  { key: 'procedure', label: '手术', placeholder: '例：绝育术' },
  { key: 'clinician', label: '麻醉负责人', placeholder: '姓名 / 工号' },
];

export function CaseSetup({ metadata, onChange }: CaseSetupProps) {
  return (
    <div className="case-grid">
      {fields.map((field) => (
        <label key={field.key}>
          <span>{field.label}</span>
          <input
            value={metadata[field.key]}
            placeholder={field.placeholder}
            onChange={(event) => onChange({ ...metadata, [field.key]: event.target.value })}
          />
        </label>
      ))}
    </div>
  );
}
