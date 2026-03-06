import './HashSyncToast.css';
import { useEffect, useMemo, useState } from 'react';

type HashSyncStatus = 'checking' | 'downloading' | 'success' | 'error';

interface HashSyncToastProps {
  status: HashSyncStatus;
  message: string;
  onDismiss: () => void;
}

export default function HashSyncToast({ status, message, onDismiss }: HashSyncToastProps) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const isBusy = status === 'checking' || status === 'downloading';
  const icon = status === 'success' ? '✓' : status === 'error' ? '!' : '⟳';
  const title =
    status === 'success'
      ? 'Hash Update Complete'
      : status === 'error'
        ? 'Hash Update Failed'
        : 'Hash Update';

  useEffect(() => {
    if (!isBusy) {
      setElapsedSeconds(0);
      return;
    }
    setElapsedSeconds(0);
    const started = Date.now();
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => clearInterval(timer);
  }, [isBusy, status, message]);

  const progressText = useMemo(() => {
    if (!isBusy) return null;
    return `Elapsed ${elapsedSeconds}s`;
  }, [isBusy, elapsedSeconds]);

  return (
    <div className={`hash-sync-toast ${status}`}>
      <div className={`hash-sync-toast-icon ${isBusy ? 'spin' : ''}`}>{icon}</div>
      <div className="hash-sync-toast-body">
        <div className="hash-sync-toast-title">{title}</div>
        <div className="hash-sync-toast-sub">{message}</div>
        {progressText && (
          <div className="hash-sync-toast-progress-text">{progressText}</div>
        )}
      </div>
      <button className="hash-sync-toast-close" onClick={onDismiss} title="Dismiss">
        &times;
      </button>
      <div className={`hash-sync-toast-progress ${isBusy ? 'busy' : status}`} />
    </div>
  );
}
