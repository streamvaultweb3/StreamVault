import { useState } from 'react';
import type { UploadedTrackRecord } from '../lib/uploadedTracks';
import { uploadedTrackLicenseBadges, uploadedTrackShareUrl } from '../lib/uploadedTracks';
import styles from './UploadedTrackMeta.module.css';

interface UploadedTrackMetaProps {
  track: UploadedTrackRecord;
  compact?: boolean;
}

export function UploadedTrackMeta({ track, compact = false }: UploadedTrackMetaProps) {
  const [copied, setCopied] = useState(false);
  const url = uploadedTrackShareUrl(track);
  const badges = uploadedTrackLicenseBadges(track);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      console.warn('[upload] Failed to copy Arweave link', e);
    }
  };

  return (
    <div className={compact ? `${styles.wrap} ${styles.wrapCompact}` : styles.wrap}>
      {!compact && (
        <div className={styles.badges}>
          {badges.map((badge) => (
            <span key={badge} className={styles.badge}>{badge}</span>
          ))}
        </div>
      )}
      <div className={compact ? `${styles.actions} ${styles.actionsCompact}` : styles.actions}>
        <a className={styles.linkBtn} href={url} target="_blank" rel="noopener noreferrer">
          {compact ? 'Open' : 'Open on Arweave'}
        </a>
        <button
          type="button"
          className={compact ? `${styles.copyBtn} ${styles.copyBtnCompact}` : styles.copyBtn}
          onClick={handleCopy}
          aria-label={copied ? 'Copied Arweave link' : 'Copy Arweave link'}
          title={copied ? 'Copied' : 'Copy Arweave link'}
        >
          {copied ? 'Copied' : '⧉'}
        </button>
      </div>
    </div>
  );
}
