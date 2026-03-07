import { useEffect, useRef } from 'react';
import './EditorContextMenu.css';

interface EditorContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onFoldEmitters: () => void;
  onUnfoldEmitters: () => void;
  hasEmitters: boolean;
}

export default function EditorContextMenu({
  x,
  y,
  onClose,
  onCut,
  onCopy,
  onPaste,
  onSelectAll,
  onFoldEmitters,
  onUnfoldEmitters,
  hasEmitters,
}: EditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleScroll = () => onClose();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  // Clamp menu position to viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const el = menuRef.current;
      if (rect.right > window.innerWidth) {
        el.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        el.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    }
  }, [x, y]);

  const handleAction = (action: () => void) => {
    action();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="editor-ctx-menu"
      style={{ left: x, top: y }}
    >
      <button className="editor-ctx-item" onClick={() => handleAction(onCut)}>
        <span className="editor-ctx-label">Cut</span>
        <span className="editor-ctx-shortcut">Ctrl+X</span>
      </button>
      <button className="editor-ctx-item" onClick={() => handleAction(onCopy)}>
        <span className="editor-ctx-label">Copy</span>
        <span className="editor-ctx-shortcut">Ctrl+C</span>
      </button>
      <button className="editor-ctx-item" onClick={() => handleAction(onPaste)}>
        <span className="editor-ctx-label">Paste</span>
        <span className="editor-ctx-shortcut">Ctrl+V</span>
      </button>
      <div className="editor-ctx-separator" />
      <button className="editor-ctx-item" onClick={() => handleAction(onSelectAll)}>
        <span className="editor-ctx-label">Select All</span>
        <span className="editor-ctx-shortcut">Ctrl+A</span>
      </button>
      {hasEmitters && (
        <>
          <div className="editor-ctx-separator" />
          <button className="editor-ctx-item" onClick={() => handleAction(onFoldEmitters)}>
            <span className="editor-ctx-label">Fold All Emitters</span>
          </button>
          <button className="editor-ctx-item" onClick={() => handleAction(onUnfoldEmitters)}>
            <span className="editor-ctx-label">Unfold All Emitters</span>
          </button>
        </>
      )}
    </div>
  );
}
