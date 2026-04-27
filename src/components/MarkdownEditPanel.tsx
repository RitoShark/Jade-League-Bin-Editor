import { useCallback, useEffect, useState } from 'react';
import './GeneralEditPanel.css';
import './MarkdownEditPanel.css';

export interface MarkdownEditPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Wrap the editor's selection with `before` and `after`. Returns false
   *  (and asks the user via status) if nothing is selected. */
  wrapSelection: (before: string, after: string) => boolean;
  /** Prefix every line in the selection (or the caret line) with `prefix`. */
  prefixLines: (prefix: string) => boolean;
  /** Insert text at the caret position (no selection requirement). */
  insertAtCaret: (text: string) => boolean;
}

export default function MarkdownEditPanel({
  isOpen,
  onClose,
  wrapSelection,
  prefixLines,
  insertAtCaret,
}: MarkdownEditPanelProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [panelRight, setPanelRight] = useState('28px');
  const [status, setStatus] = useState('');

  // Keep status messages from sticking around forever.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(''), 3500);
    return () => clearTimeout(t);
  }, [status]);

  const updatePanelPosition = useCallback(() => {
    const editorContainer = document.querySelector('.editor-container') as HTMLElement | null;
    if (!editorContainer) return;
    const containerRect = editorContainer.getBoundingClientRect();
    const minimap = editorContainer.querySelector('.monaco-editor .minimap') as HTMLElement | null;
    // Monaco keeps the .minimap DOM node around even when minimap is
    // disabled in editor options — it just collapses the width to 0.
    // Only treat it as "present" when it actually takes space, otherwise
    // its bogus rect throws off our offset math and pushes the panel
    // entirely off-screen.
    if (minimap && minimap.offsetWidth > 0) {
      const minimapRect = minimap.getBoundingClientRect();
      const minimapWidth = Math.max(0, containerRect.right - minimapRect.left);
      setPanelRight(`${Math.round(minimapWidth + 14)}px`);
      return;
    }
    setPanelRight('28px');
  }, []);

  useEffect(() => {
    if (isOpen) {
      setIsRendered(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setIsVisible(true)));
      updatePanelPosition();
    } else {
      setIsVisible(false);
      const timer = setTimeout(() => setIsRendered(false), 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen, updatePanelPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = () => updatePanelPosition();
    window.addEventListener('resize', handler);
    // Re-measure when a perf preference (minimap on/off etc.) changes
    // — Monaco re-lays out internally but the window doesn't resize.
    const handlePerfPref = () => {
      requestAnimationFrame(() => requestAnimationFrame(updatePanelPosition));
    };
    window.addEventListener('perf-pref-changed', handlePerfPref);
    let ro: ResizeObserver | null = null;
    const container = document.querySelector('.editor-container');
    if (container && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => updatePanelPosition());
      ro.observe(container);
      const monacoEl = container.querySelector('.monaco-editor');
      if (monacoEl) ro.observe(monacoEl);
    }
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('perf-pref-changed', handlePerfPref);
      ro?.disconnect();
    };
  }, [isOpen, updatePanelPosition]);

  const wrap = (before: string, after: string, label: string) => {
    if (!wrapSelection(before, after)) {
      setStatus(`Select some text first to apply ${label}.`);
    } else {
      setStatus(`Applied ${label}.`);
    }
  };

  const prefix = (p: string, label: string) => {
    if (!prefixLines(p)) {
      setStatus(`Place the caret on a line first to apply ${label}.`);
    } else {
      setStatus(`Applied ${label}.`);
    }
  };

  const insert = (text: string, label: string) => {
    if (!insertAtCaret(text)) {
      setStatus(`Place the caret in the editor first to ${label}.`);
    } else {
      setStatus(`${label} inserted.`);
    }
  };

  if (!isRendered) return null;

  return (
    <div className="general-edit-panel-wrapper">
      <div
        className={`general-edit-panel ${isVisible ? 'visible' : ''}`}
        style={{ right: panelRight }}
      >
        <div className="gep-left-bar" />
        <div className="gep-header">
          <span className="gep-title">Markdown</span>
          <button className="gep-close-btn" onClick={onClose} aria-label="Close (Escape)" />
        </div>
        <div className="gep-divider" />

        <div className="gep-section">
          <div className="gep-section-header">
            <span className="gep-section-title">Inline</span>
          </div>
          <div className="gep-section-content">
            <div className="md-btn-grid">
              <button className="md-btn" title="Bold (wraps with **)" onClick={() => wrap('**', '**', 'bold')}>
                <span style={{ fontWeight: 800 }}>B</span>
              </button>
              <button className="md-btn" title="Italic (wraps with *)" onClick={() => wrap('*', '*', 'italic')}>
                <span style={{ fontStyle: 'italic' }}>I</span>
              </button>
              <button className="md-btn" title="Strikethrough (~~)" onClick={() => wrap('~~', '~~', 'strikethrough')}>
                <span style={{ textDecoration: 'line-through' }}>S</span>
              </button>
              <button className="md-btn" title="Inline code (`)" onClick={() => wrap('`', '`', 'inline code')}>
                <span style={{ fontFamily: 'JetBrains Mono, Consolas, monospace' }}>{'<>'}</span>
              </button>
            </div>
          </div>
        </div>

        <div className="gep-divider" />

        <div className="gep-section">
          <div className="gep-section-header">
            <span className="gep-section-title">Headings</span>
          </div>
          <div className="gep-section-content">
            <div className="md-btn-grid md-btn-grid-3">
              <button className="md-btn" title="Heading 1" onClick={() => prefix('# ', 'H1')}>H1</button>
              <button className="md-btn" title="Heading 2" onClick={() => prefix('## ', 'H2')}>H2</button>
              <button className="md-btn" title="Heading 3" onClick={() => prefix('### ', 'H3')}>H3</button>
            </div>
          </div>
        </div>

        <div className="gep-divider" />

        <div className="gep-section">
          <div className="gep-section-header">
            <span className="gep-section-title">Block</span>
          </div>
          <div className="gep-section-content">
            <div className="md-btn-grid md-btn-grid-3">
              <button className="md-btn" title="Bullet list" onClick={() => prefix('- ', 'bullet list')}>•&nbsp;List</button>
              <button className="md-btn" title="Numbered list" onClick={() => prefix('1. ', 'numbered list')}>1.&nbsp;List</button>
              <button className="md-btn" title="Quote" onClick={() => prefix('> ', 'quote')}>{'> Quote'}</button>
              <button className="md-btn" title="Code block" onClick={() => wrap('```\n', '\n```', 'code block')}>
                Code&nbsp;block
              </button>
              <button className="md-btn" title="Link" onClick={() => wrap('[', '](url)', 'link')}>Link</button>
              <button className="md-btn" title="Horizontal rule" onClick={() => insert('\n---\n', 'horizontal rule')}>Rule</button>
            </div>
          </div>
        </div>

        {status && <div className="gep-status md-status">{status}</div>}
      </div>
    </div>
  );
}
