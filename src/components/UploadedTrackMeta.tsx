import { useState } from 'react';
import { Link } from 'react-router-dom';
import { trackDetailPath } from '../lib/arweaveTxDetail';
import type { UploadedTrackRecord } from '../lib/uploadedTracks';
import { uploadedTrackCompactBadges, uploadedTrackLicenseBadges, uploadedTrackShareUrl } from '../lib/uploadedTracks';
import styles from './UploadedTrackMeta.module.css';

interface UploadedTrackMetaProps {
  track: UploadedTrackRecord;
  compact?: boolean;
  /** Hide badge row (e.g. when badges render in parent). */
  hideBadges?: boolean;
}

export function UploadedTrackMeta({ track, compact = false, hideBadges = false }: UploadedTrackMetaProps) {
  const [copied, setCopied] = useState(false);
  const url = uploadedTrackShareUrl(track);
  const badges = compact ? uploadedTrackCompactBadges(track) : uploadedTrackLicenseBadges(track);

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
      {!hideBadges && badges.length > 0 && (
        <div className={compact ? `${styles.badges} ${styles.badgesCompact}` : styles.badges}>
          {badges.map((badge) => (
            <span key={badge} className={styles.badge}>{badge}</span>
          ))}
        </div>
      )}
      <div className={compact ? `${styles.actions} ${styles.actionsCompact}` : styles.actions}>
        <Link to={trackDetailPath(track.txId)} className={styles.linkBtn}>
          {compact ? 'Details' : 'Track details'}
        </Link>
        {!compact && (
          <a className={styles.linkBtn} href={url} target="_blank" rel="noopener noreferrer">
            Open data
          </a>
        )}
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
