import { useEffect, useRef, useState } from 'react';
import './NewFileDialog.css';

interface NewFileDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  onCreate: (fileName: string) => void;
}

const QUICK_EXTENSIONS = [
  { ext: 'txt',  label: 'Plain text'  },
  { ext: 'md',   label: 'Markdown'    },
  { ext: 'json', label: 'JSON'        },
  { ext: 'bin',  label: 'BIN (ritobin)' },
];

export default function NewFileDialog({ isOpen, onCancel, onCreate }: NewFileDialogProps) {
  const [name, setName] = useState('Untitled');
  const [extension, setExtension] = useState('txt');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the name input when the dialog opens; reset to defaults each time.
  useEffect(() => {
    if (!isOpen) return;
    setName('Untitled');
    setExtension('txt');
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [isOpen]);

  if (!isOpen) return null;

  const sanitizedName = name.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\.+$/, '') || 'Untitled';
  const sanitizedExt = extension.trim().replace(/^\.+/, '').toLowerCase();
  const finalName = sanitizedExt ? `${sanitizedName}.${sanitizedExt}` : sanitizedName;

  const submit = () => {
    onCreate(finalName);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
  };

  return (
    <div className="newfile-overlay" onMouseDown={onCancel}>
      <div className="newfile-dialog" onMouseDown={e => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="newfile-header">
          <h3>New File</h3>
          <button className="newfile-close" onClick={onCancel} title="Cancel (Escape)">&times;</button>
        </div>

        <div className="newfile-body">
          <label className="newfile-label" htmlFor="newfile-name">File name</label>
          <input
            id="newfile-name"
            ref={inputRef}
            type="text"
            className="newfile-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Untitled"
          />

          <label className="newfile-label" htmlFor="newfile-ext">Extension</label>
          <div className="newfile-ext-row">
            <span className="newfile-ext-dot">.</span>
            <input
              id="newfile-ext"
              type="text"
              className="newfile-input newfile-input-ext"
              value={extension}
              onChange={e => setExtension(e.target.value)}
              placeholder="txt"
              spellCheck={false}
            />
          </div>

          <div className="newfile-quick-row">
            {QUICK_EXTENSIONS.map(opt => (
              <button
                key={opt.ext}
                type="button"
                className={`newfile-quick-btn${extension.toLowerCase() === opt.ext ? ' active' : ''}`}
                onClick={() => setExtension(opt.ext)}
                title={opt.label}
              >
                .{opt.ext}
              </button>
            ))}
          </div>

          <div className="newfile-preview">
            <span className="newfile-preview-label">Will create:</span>
            <span className="newfile-preview-name">{finalName}</span>
          </div>
        </div>

        <div className="newfile-footer">
          <button className="newfile-btn newfile-btn-cancel" onClick={onCancel}>Cancel</button>
          <button className="newfile-btn newfile-btn-create" onClick={submit}>Create</button>
        </div>
      </div>
    </div>
  );
}
