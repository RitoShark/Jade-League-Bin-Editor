import { useEffect, useRef } from 'react';
import './TexHoverPopup.css';

export interface TexHoverPopupProps {
  /** Pixel Y where the popup anchors (line top or bottom edge) */
  top: number;
  /** Pixel X for the popup (line start) */
  left: number;
  /** If true, popup opens above the line instead of below */
  above: boolean;
  /** Raw path string extracted from the editor */
  rawPath: string;
  /** Resolved absolute path, null while resolving */
  resolvedPath: string | null;
  /** PNG data URL from decoded .tex, null while loading */
  imageDataUrl: string | null;
  /** Decoded texture dimensions */
  texWidth: number;
  texHeight: number;
  /** Human-readable format name */
  formatName: string;
  /** Error message if loading failed */
  error: string | null;
  onOpenFull: () => void;
  onEditImage: () => void;
  onShowInExplorer: () => void;
  /** Called to close the popup */
  onClose: () => void;
  /** Called when mouse enters the popup */
  onMouseEnter?: () => void;
  /** Called when mouse leaves the popup */
  onMouseLeave?: () => void;
}

export default function TexHoverPopup({
  top, left, above,
  rawPath,
  resolvedPath,
  imageDataUrl,
  texWidth,
  texHeight,
  formatName,
  error,
  onOpenFull,
  onEditImage,
  onShowInExplorer,
  onClose,
  onMouseEnter: onMouseEnterProp,
  onMouseLeave: onMouseLeaveProp,
}: TexHoverPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const dismissTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isOverPopup = useRef(false);

  const cancelDismiss = () => {
    if (dismissTimeout.current) { clearTimeout(dismissTimeout.current); dismissTimeout.current = null; }
  };

  const scheduleDismiss = () => {
    cancelDismiss();
    dismissTimeout.current = setTimeout(() => {
      if (!isOverPopup.current) onClose();
    }, 350);
  };

  // Dismiss when mouse leaves the popup (with forgiving delay)
  useEffect(() => {
    const popup = popupRef.current;
    if (!popup) return;
    const onEnter = () => {
      isOverPopup.current = true;
      cancelDismiss();
      onMouseEnterProp?.();
    };
    const onLeave = () => {
      isOverPopup.current = false;
      onMouseLeaveProp?.();
      scheduleDismiss();
    };
    popup.addEventListener('mouseenter', onEnter);
    popup.addEventListener('mouseleave', onLeave);
    return () => {
      popup.removeEventListener('mouseenter', onEnter);
      popup.removeEventListener('mouseleave', onLeave);
      cancelDismiss();
    };
  });

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Position: anchored below or above the line, clamped to viewport
  const POPUP_W = 260;
  const GAP = 4;
  const vw = window.innerWidth;

  let finalLeft = left;
  if (finalLeft + POPUP_W > vw - 8) finalLeft = vw - POPUP_W - 8;
  if (finalLeft < 8) finalLeft = 8;

  const style: React.CSSProperties = {
    left: finalLeft,
    ...(above
      ? { bottom: window.innerHeight - top + GAP }
      : { top: top + GAP }),
  };

  const fileName = rawPath.replace(/\\/g, '/').split('/').pop() || rawPath;

  // Draw decoded image onto canvas when imageDataUrl arrives
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!imageDataUrl || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  return (
    <div
      ref={popupRef}
      className="tex-hover-popup"
      style={style}
    >
      <div className="tex-hover-popup__header">
        <span className="tex-hover-popup__filename" title={resolvedPath || rawPath}>
          {fileName}
        </span>
      </div>

      <div className="tex-hover-popup__preview">
        {error ? (
          <div className="tex-hover-popup__error">
            <span className="tex-hover-popup__error-icon">⚠</span>
            <span>{error}</span>
          </div>
        ) : imageDataUrl ? (
          <canvas
            ref={canvasRef}
            className="tex-hover-popup__canvas"
            title={`${texWidth} × ${texHeight} · ${formatName}`}
          />
        ) : (
          <div className="tex-hover-popup__loading">
            <div className="tex-hover-popup__spinner" />
            <span>Loading texture…</span>
          </div>
        )}
      </div>

      {!error && imageDataUrl && (
        <div className="tex-hover-popup__meta">
          {texWidth} × {texHeight} · {formatName}
        </div>
      )}

      <div className="tex-hover-popup__actions">
        <button
          className="tex-hover-popup__btn tex-hover-popup__btn--primary"
          onClick={onOpenFull}
          disabled={!imageDataUrl && !error}
          title="Open full-size preview in a new tab"
        >
          Open Full
        </button>
        <button
          className="tex-hover-popup__btn tex-hover-popup__btn--secondary"
          onClick={onEditImage}
          disabled={!resolvedPath}
          title="Open in Paint.NET"
        >
          Edit Image
        </button>
        <button
          className="tex-hover-popup__btn tex-hover-popup__btn--secondary tex-hover-popup__btn--icon"
          onClick={onShowInExplorer}
          disabled={!resolvedPath}
          title="Show in Explorer"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A.5.5 0 0 0 8.914 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
