import './FileLoadingToast.css';

interface FileLoadingToastProps {
  fileName: string;
  detail?: string;
}

export default function FileLoadingToast({ fileName, detail }: FileLoadingToastProps) {
  return (
    <div className="file-loading-overlay" role="status" aria-live="polite">
      <div className="file-loading-card">
        <div className="file-loading-text">
          <div className="file-loading-title">Loading {fileName}</div>
          <div className="file-loading-sub">{detail ?? 'Parsing content - please wait a moment.'}</div>
        </div>
        {/* Indeterminate progress bar — shares the green-fill + shimmer
            treatment with the WAD-extract status bar. The fill is
            permanently full-width; the moving streak inside it is the
            "this is still working" cue. */}
        <div className="file-loading-progress" aria-hidden="true">
          <div className="file-loading-progress-fill" />
        </div>
      </div>
    </div>
  );
}
