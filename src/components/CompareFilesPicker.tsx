import { useState } from 'react';
import type { EditorTab } from './TabBar';
import './CompareFilesPicker.css';

interface CompareFilesPickerProps {
  editorTabs: EditorTab[];
  initialLeftId: string;
  initialRightId: string;
  onCancel: () => void;
  onConfirm: (leftId: string, rightId: string) => void;
}

export default function CompareFilesPicker({
  editorTabs,
  initialLeftId,
  initialRightId,
  onCancel,
  onConfirm,
}: CompareFilesPickerProps) {
  const [leftId, setLeftId] = useState(initialLeftId);
  const [rightId, setRightId] = useState(initialRightId);

  const sameSide = leftId === rightId;

  return (
    <div className="compare-picker-overlay" onClick={onCancel}>
      <div className="compare-picker-modal" onClick={e => e.stopPropagation()}>
        <div className="compare-picker-header">
          <span>Compare Files</span>
          <button className="compare-picker-close" onClick={onCancel} aria-label="Close">×</button>
        </div>
        <div className="compare-picker-body">
          <div className="compare-picker-row">
            <label>Left</label>
            <select value={leftId} onChange={e => setLeftId(e.target.value)}>
              {editorTabs.map(t => (
                <option key={t.id} value={t.id}>{t.fileName}</option>
              ))}
            </select>
          </div>
          <div className="compare-picker-row">
            <label>Right</label>
            <select value={rightId} onChange={e => setRightId(e.target.value)}>
              {editorTabs.map(t => (
                <option key={t.id} value={t.id}>{t.fileName}</option>
              ))}
            </select>
          </div>
          {sameSide && (
            <div className="compare-picker-hint">Pick two different files.</div>
          )}
        </div>
        <div className="compare-picker-footer">
          <button className="compare-picker-btn" onClick={onCancel}>Cancel</button>
          <button
            className="compare-picker-btn compare-picker-btn--primary"
            onClick={() => onConfirm(leftId, rightId)}
            disabled={sameSide}
          >
            Compare
          </button>
        </div>
      </div>
    </div>
  );
}
