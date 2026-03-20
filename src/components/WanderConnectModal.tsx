import styles from './WanderConnectModal.module.css';

type Props = {
  open: boolean;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onUseWanderConnect: () => void;
};

export function WanderConnectModal({
  open,
  busy = false,
  error = null,
  onClose,
  onUseWanderConnect,
}: Props) {
  if (!open) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={styles.modal + ' glass-strong'}
        role="dialog"
        aria-modal="true"
        aria-label="Connect Arweave wallet"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className={styles.title}>Connect Arweave wallet</h3>
        <p className={styles.copy}>
          Wander extension was not detected. You can install it, or continue with Wander Connect (email/social login).
        </p>
        <p className={styles.note}>
          If you use Wander Connect, complete login in the popup then click connect again.
        </p>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={onUseWanderConnect}
            disabled={busy}
          >
            {busy ? 'Starting…' : 'Use Wander Connect'}
          </button>
          <a
            className={styles.secondaryBtn}
            href="https://wander.app/download"
            target="_blank"
            rel="noopener noreferrer"
          >
            Install Wander Extension
          </a>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
