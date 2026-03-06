import './QuartzInstallModal.css';

interface QuartzInstallModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDownload: () => void;
}

export default function QuartzInstallModal({ isOpen, onClose, onDownload }: QuartzInstallModalProps) {
  if (!isOpen) return null;

  return (
    <div className="quartz-install-backdrop" onClick={onClose}>
      <div className="quartz-install-modal" onClick={(e) => e.stopPropagation()}>
        <div className="quartz-install-accent" />
        <div className="quartz-install-title">Quartz Is Not Installed</div>
        <div className="quartz-install-text">
          Quartz is a toolkit for League of Legends modding. It includes dedicated workflows like Paint,
          Port, BinEditor, and VFXHub to edit BIN content fast without VS Code setup complexity.
        </div>
        <div className="quartz-install-subtext">
          Install Quartz to use “Open in Quartz” actions from Jade.
        </div>
        <div className="quartz-install-actions">
          <button className="quartz-install-btn quartz-install-btn-secondary" onClick={onClose}>
            Close
          </button>
          <button className="quartz-install-btn quartz-install-btn-primary" onClick={onDownload}>
            Download Quartz
          </button>
        </div>
      </div>
    </div>
  );
}

