import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Track } from '../context/PlayerContext';
import { usePlayer } from '../context/PlayerContext';
import styles from './TrackCard.module.css';

interface TrackCardProps {
  track: Track;
  onPublishClick?: () => void;
  /** If set, use this for the artist link (e.g. /profile/address for vault tracks). */
  artistHref?: string;
  footerContent?: ReactNode;
  showPermanentBadge?: boolean;
}

export function TrackCard({ track, onPublishClick, artistHref, footerContent, showPermanentBadge = true }: TrackCardProps) {
  const { play, pause, currentTrack, isPlaying } = usePlayer();
  const isCurrent = currentTrack?.id === track.id;
  const artistTo = artistHref ?? `/artist/${track.artistId}`;

  const handlePlay = () => {
    if (isCurrent && isPlaying) pause();
    else play(track);
  };

  return (
    <div className={styles.card + ' glass'}>
      <button type="button" className={styles.coverWrap} onClick={handlePlay}>
        {track.artwork ? (
          <img src={track.artwork} alt="" className={styles.cover} loading="lazy" />
        ) : (
          <div className={styles.coverPlaceholder} aria-hidden="true" />
        )}
        <span className={styles.playOverlay}>
          {isCurrent && isPlaying ? (
            <span className={styles.iconPause} />
          ) : (
            <span className={styles.iconPlay} />
          )}
        </span>
      </button>
      <div className={styles.body}>
        <h3 className={styles.title}>{track.title}</h3>
        <Link to={artistTo} className={styles.artist}>
          {track.artist}
        </Link>
        <div className={styles.footer}>
          {showPermanentBadge && track.isPermanent && (
            <span className={styles.perma}>On Arweave</span>
          )}
          {onPublishClick && (
            <button type="button" className={styles.publishBtn} onClick={onPublishClick}>
              Publish to Arweave
            </button>
          )}
          {footerContent}
        </div>
      </div>
    </div>
  );
}
