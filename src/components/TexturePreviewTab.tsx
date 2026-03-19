import React, { useEffect, useRef, useState } from 'react';
import './TexturePreviewTab.css';
import { formatName } from '../lib/texFormat';

interface TexturePreviewTabProps {
  filePath: string;
  imageDataUrl: string | null;
  texWidth: number;
  texHeight: number;
  format: number;
  error: string | null;
  isReloading?: boolean;
  onEditImage: () => void;
  onShowInExplorer: () => void;
  onReload: () => void;
}

export default function TexturePreviewTab({
  filePath,
  imageDataUrl,
  texWidth,
  texHeight,
  format,
  error,
  isReloading = false,
  onEditImage,
  onShowInExplorer,
  onReload,
}: TexturePreviewTabProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);

  const fileName = filePath.replace(/\\/g, '/').split('/').pop() || filePath;

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

  const handleZoomIn = () => {
    setFitMode(false);
    setZoom(z => Math.min(z * 1.25, 16));
  };

  const handleZoomOut = () => {
    setFitMode(false);
    setZoom(z => Math.max(z / 1.25, 0.05));
  };

  const handleFit = () => {
    setFitMode(true);
    setZoom(1);
  };

  const handleZoom100 = () => {
    setFitMode(false);
    setZoom(1);
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 1 / 1.15 : 1.15;
      setFitMode(false);
      setZoom(z => Math.min(Math.max(z * delta, 0.05), 16));
    }
  };

  return (
    <div className="tex-preview-tab">
      <div className="tex-preview-tab__toolbar">
        <div className="tex-preview-tab__info">
          <span className="tex-preview-tab__filename">{fileName}</span>
          {!error && imageDataUrl && (
            <span className="tex-preview-tab__meta">
              {texWidth} × {texHeight} · {formatName(format)}
            </span>
          )}
        </div>
        <div className="tex-preview-tab__controls">
          <button className="tex-preview-tab__ctrl-btn" onClick={handleZoomOut} title="Zoom out">−</button>
          <button
            className="tex-preview-tab__ctrl-btn tex-preview-tab__ctrl-btn--zoom"
            onClick={handleZoom100}
            title="Reset to 100%"
          >
            {fitMode ? 'Fit' : `${Math.round(zoom * 100)}%`}
          </button>
          <button className="tex-preview-tab__ctrl-btn" onClick={handleZoomIn} title="Zoom in">+</button>
          <button className="tex-preview-tab__ctrl-btn" onClick={handleFit} title="Fit to window">⊡</button>
          <div className="tex-preview-tab__separator" />
          <button
            className={`tex-preview-tab__ctrl-btn tex-preview-tab__ctrl-btn--reload${isReloading ? ' reloading' : ''}`}
            onClick={onReload}
            disabled={isReloading}
            title="Reload from disk (auto-reloads on save)"
          >
            {isReloading ? <span className="tex-preview-tab__btn-spinner" /> : '↺'}
          </button>
          <button
            className="tex-preview-tab__ctrl-btn tex-preview-tab__ctrl-btn--edit"
            onClick={onEditImage}
            title="Open in image editor"
          >
            Edit Image
          </button>
          <button
            className="tex-preview-tab__ctrl-btn"
            onClick={onShowInExplorer}
            title="Show in Explorer"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ verticalAlign: 'middle', marginRight: 4 }}>
              <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.879a1.5 1.5 0 0 1 1.06.44l1.122 1.12A.5.5 0 0 0 8.914 4H13.5A1.5 1.5 0 0 1 15 5.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 12.5v-9z"/>
            </svg>
            Show in Explorer
          </button>
        </div>
      </div>

      <div className="tex-preview-tab__viewport" onWheel={handleWheel}>
        {error ? (
          <div className="tex-preview-tab__error">
            <div className="tex-preview-tab__error-icon">⚠</div>
            <div className="tex-preview-tab__error-title">Failed to load texture</div>
            <div className="tex-preview-tab__error-msg">{error}</div>
            <div className="tex-preview-tab__error-path">{filePath}</div>
          </div>
        ) : imageDataUrl ? (
          <div
            className="tex-preview-tab__canvas-wrap"
            style={fitMode ? { width: '100%', height: '100%' } : undefined}
          >
            <canvas
              ref={canvasRef}
              className="tex-preview-tab__canvas"
              style={fitMode
                ? { maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto' }
                : { width: `${texWidth * zoom}px`, height: `${texHeight * zoom}px` }
              }
            />
          </div>
        ) : (
          <div className="tex-preview-tab__loading">
            <div className="tex-preview-tab__spinner" />
            <span>Decoding texture…</span>
          </div>
        )}
      </div>
    </div>
  );
}
