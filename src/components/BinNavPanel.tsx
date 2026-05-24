import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useShell } from '../shells/ShellContext';
// Reuse the shared edit-panel chrome (.general-edit-panel / .gep-*).
// GeneralEditPanel + MarkdownEditPanel already share these classes, so
// BinNavPanel inherits the popup animation, docked overrides (Dock.css)
// and modern-UI glass styling for free.
import './GeneralEditPanel.css';

/**
 * Bin Navigation panel — jump shortcuts for the sections people hop to
 * most while editing champion bins: `animationGraphData`,
 * `ResourceResolver`, and `materialOverride`.
 *
 * Rendered two ways, like GeneralEditPanel:
 *   - floating popup anchored to the editor (classic / VSCode shell)
 *   - docked tool window (`docked`) inside the Visual Studio shell.
 */
interface BinNavPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Current editor text — scanned for the navigable section lines. */
  editorContent: string;
  /** Reveals + focuses a 1-based line in the active editor. */
  onScrollToLine: (line: number) => void;
  /** When true, render as a plain block element for a host dock pane
   *  instead of the absolutely-positioned floating popup. */
  docked?: boolean;
}

interface NavTarget {
  key: string;
  label: string;
  /** 1-based line number, or null when the section isn't in the file. */
  line: number | null;
}

/** Scan order matters only for display — each target is independent. */
function scanTargets(content: string): NavTarget[] {
  const lines = content ? content.split('\n') : [];
  const findLine = (re: RegExp): number | null => {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return i + 1;
    }
    return null;
  };

  // AnimationGraphData / ResourceResolver are TOP-LEVEL entries — a
  // path or `0x…` hash key, then ` = ClassName {`. A bare
  // `= ClassName {` also matches nested / field uses
  // (e.g. `someField: embed = ResourceResolver {`), which is the wrong
  // one — so require the line to *start* (after indent) with a
  // quoted-string or hash key.
  const entryRe = (className: string) =>
    new RegExp(`^\\s*("[^"]*"|0x[0-9a-fA-F]+)\\s*=\\s*${className}\\s*\\{`, 'i');

  // ResourceResolver: prefer the entry whose body opens with the
  // `resourceMap` block (the real container), but fall back to the
  // first path/hash-keyed entry if none confirm.
  const resourceEntryRe = entryRe('ResourceResolver');
  const findResourceResolver = (): number | null => {
    for (let i = 0; i < lines.length; i++) {
      if (!resourceEntryRe.test(lines[i])) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t === '') continue;
        if (/^resourceMap\s*:/i.test(t)) return i + 1;
        break; // first non-blank line wasn't resourceMap — keep looking
      }
    }
    return findLine(resourceEntryRe);
  };

  return [
    {
      key: 'anim',
      label: 'Animation Graph Data',
      line: findLine(entryRe('AnimationGraphData')),
    },
    {
      key: 'resource',
      label: 'Resource Resolver',
      line: findResourceResolver(),
    },
    {
      key: 'material',
      label: 'Material Override',
      line: findLine(/materialoverride\s*:/i),
    },
  ];
}

export default function BinNavPanel({
  isOpen,
  onClose,
  editorContent,
  onScrollToLine,
  docked = false,
}: BinNavPanelProps) {
  const s = useShell();
  // Slide-down animation state — mirrors GeneralEditPanel exactly.
  const [isVisible, setIsVisible] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [panelRight, setPanelRight] = useState('28px');
  const [targets, setTargets] = useState<NavTarget[]>(() => scanTargets(editorContent));
  // Persisted via the `BinNavMinimapHighlight` pref — when on, the three
  // nav targets get accent-coloured ticks on Monaco's minimap so the
  // user can spot them at a glance even with the panel closed-ish.
  const [minimapHighlight, setMinimapHighlight] = useState(true);

  useEffect(() => {
    invoke<string>('get_preference', { key: 'BinNavMinimapHighlight', defaultValue: 'True' })
      .then(v => setMinimapHighlight(v !== 'False'))
      .catch(() => {});
  }, []);

  const toggleMinimapHighlight = (next: boolean) => {
    setMinimapHighlight(next);
    invoke('set_preference', { key: 'BinNavMinimapHighlight', value: next ? 'True' : 'False' })
      .catch(() => {});
  };

  // Apply minimap line decorations for the resolved nav targets. Cleanup
  // disposes the collection so closing the panel / toggling the option
  // off / switching tabs all clear cleanly. Only fires when the panel
  // is open AND the toggle is on, so the cost is opt-in.
  useEffect(() => {
    if (!isOpen || !minimapHighlight) return;
    const editor = s.editorRef.current;
    const monaco = s.monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    const totalLines = model.getLineCount();

    const lines = targets
      .map(t => t.line)
      .filter((n): n is number => n !== null && n >= 1 && n <= totalLines);
    if (lines.length === 0) return;

    // Pick up whatever the active theme set on `--jade-accent` so the
    // marks match the rest of the chrome. Fall back to the default
    // accent if the var isn't present (custom themes, race on first paint).
    const accent =
      getComputedStyle(document.documentElement).getPropertyValue('--jade-accent').trim()
      || '#4a9870';

    const collection = editor.createDecorationsCollection(
      lines.map(line => ({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          minimap: {
            color: accent,
            position: monaco.editor.MinimapPosition.Inline,
          },
        },
      })),
    );
    return () => { collection.clear(); };
  }, [isOpen, minimapHighlight, targets, s.editorRef, s.monacoRef]);

  // Pin the floating panel to the left edge of the minimap when one is
  // rendered, else 28px from the right edge. Same logic GeneralEditPanel
  // and ParticleEditorPanel use so the panels line up.
  const updatePanelPosition = useCallback(() => {
    const editorContainer = document.querySelector('.editor-container') as HTMLElement | null;
    if (!editorContainer) return;
    const containerRect = editorContainer.getBoundingClientRect();
    const minimap = editorContainer.querySelector('.monaco-editor .minimap') as HTMLElement | null;
    if (minimap && minimap.offsetWidth > 0) {
      const minimapRect = minimap.getBoundingClientRect();
      const minimapWidth = Math.max(0, containerRect.right - minimapRect.left);
      setPanelRight(`${Math.round(minimapWidth + 14)}px`);
      return;
    }
    setPanelRight('28px');
  }, []);

  // Open/close animation.
  useEffect(() => {
    if (isOpen) {
      setIsRendered(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setIsVisible(true));
      });
      if (!docked) updatePanelPosition();
    } else {
      setIsVisible(false);
      const timer = setTimeout(() => setIsRendered(false), docked ? 0 : 200);
      return () => clearTimeout(timer);
    }
  }, [isOpen, docked, updatePanelPosition]);

  // Re-measure on resize / perf-pref toggles / editor layout shifts —
  // skipped when docked (the host pane owns the geometry).
  useEffect(() => {
    if (!isOpen || docked) return;
    const handleResize = () => updatePanelPosition();
    window.addEventListener('resize', handleResize);
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
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('perf-pref-changed', handlePerfPref);
      ro?.disconnect();
    };
  }, [isOpen, docked, updatePanelPosition]);

  // Re-scan the content for section lines while the panel is open.
  // Debounced so a large bin isn't re-split on every keystroke.
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    scanTimeoutRef.current = setTimeout(() => {
      setTargets(scanTargets(editorContent));
    }, 150);
    return () => {
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    };
  }, [isOpen, editorContent]);

  if (!isRendered) return null;

  return (
    <div className={`general-edit-panel-wrapper${docked ? ' docked' : ''}`}>
      <div
        className={`general-edit-panel ${docked ? 'docked' : ''} ${isVisible ? 'visible' : ''}`}
        style={docked ? undefined : { right: panelRight }}
      >
        <div className="gep-left-bar" />
        <div className="gep-header">
          <span className="gep-title">Bin Navigation</span>
          <button
            className="gep-close-btn"
            onClick={onClose}
            aria-label="Close (Escape)"
          />
        </div>
        <div className="gep-divider" />

        <div className="gep-section">
          <div className="gep-section-content">
            {targets.map((t) => (
              <div className="gep-row" key={t.key} style={{ marginBottom: 4 }}>
                <button
                  className="gep-btn gep-btn-full"
                  style={{ flex: 1, justifyContent: 'space-between' }}
                  disabled={t.line === null}
                  onClick={() => { if (t.line !== null) onScrollToLine(t.line); }}
                  title={t.line !== null
                    ? `Jump to ${t.label} (line ${t.line})`
                    : `${t.label} not found in this file`}
                >
                  <span>{t.label}</span>
                  <span style={{ opacity: 0.55, fontSize: 11, marginLeft: 8 }}>
                    {t.line !== null ? `L${t.line}` : '—'}
                  </span>
                </button>
              </div>
            ))}

            <label
              className="gep-row"
              style={{
                marginTop: 6,
                cursor: 'pointer',
                userSelect: 'none',
                fontSize: 12,
              }}
              title="Color these three lines on Monaco's minimap so they're easy to spot"
            >
              <input
                type="checkbox"
                checked={minimapHighlight}
                onChange={e => toggleMinimapHighlight(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>Highlight on minimap</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
