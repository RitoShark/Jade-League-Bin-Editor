import './FileLoadingToast.css';

interface FileLoadingToastProps {
  fileName: string;
  detail?: string;
}

export default function FileLoadingToast({ fileName, detail }: FileLoadingToastProps) {
  return (
    <div className="file-loading-overlay" role="status" aria-live="polite">
      <div className="file-loading-card">
        <div className="file-loading-spinner" aria-hidden="true">
          <span className="file-loading-spinner-ring" />
        </div>
        <div className="file-loading-text">
          <div className="file-loading-title">Loading {fileName}</div>
          <div className="file-loading-sub">{detail ?? 'Parsing bin - please wait a moment.'}</div>
        </div>
      </div>
    </div>
  );
}
