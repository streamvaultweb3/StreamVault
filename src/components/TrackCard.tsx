import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Track } from '../context/PlayerContext';
import { usePlayer } from '../context/PlayerContext';
import { trackDetailPath } from '../lib/arweaveTxDetail';
import { defaultArtistHrefForTrack } from '../lib/arweaveArtist';
import { trackHasAtomicAsset } from '../lib/trackBadges';
import { useArweaveMediaSources } from '../hooks/useArweaveMediaSources';
import styles from './TrackCard.module.css';

interface TrackCardProps {
  track: Track;
  onPublishClick?: () => void;
  /** If set, use this for the artist link (e.g. /artist/arweave/:wallet). */
  artistHref?: string;
  /** If set, use this for the track title link (defaults to /track/:txId for permanent uploads). */
  titleHref?: string;
  footerContent?: ReactNode;
  showPermanentBadge?: boolean;
  /** Force atomic tile styling; defaults to true when track.assetId is set. */
  atomicAsset?: boolean;
}

function defaultTitleHref(track: Track): string | undefined {
  const txId = track.permaTxId || (track.isPermanent ? track.id : undefined);
  return txId ? trackDetailPath(txId) : undefined;
}

export function TrackCard({
  track,
  onPublishClick,
  artistHref,
  titleHref,
  footerContent,
  showPermanentBadge = true,
  atomicAsset,
}: TrackCardProps) {
  const { play, pause, currentTrack, isPlaying } = usePlayer();
  const isCurrent = currentTrack?.id === track.id;
  const artistTo = artistHref ?? defaultArtistHrefForTrack(track) ?? `/artist/${track.artistId}`;
  const titleTo = titleHref ?? defaultTitleHref(track);
  const { src: artworkSource, onError: onArtworkError, onLoad: onArtworkLoad } = useArweaveMediaSources(track.artwork || '');
  const isAtomic = atomicAsset ?? trackHasAtomicAsset(track);

  const handlePlay = () => {
    if (isCurrent && isPlaying) pause();
    else play(track);
  };

  return (
    <div
      className={[
        'glass',
        styles.card,
        isAtomic ? styles.cardAtomic : track.isPermanent ? styles.cardPermanent : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <button type="button" className={styles.coverWrap} onClick={handlePlay}>
        {artworkSource ? (
          <img
            src={artworkSource}
            alt=""
            className={styles.cover}
            loading="lazy"
            onError={onArtworkError}
            onLoad={onArtworkLoad}
          />
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
        {titleTo ? (
          <Link to={titleTo} className={styles.titleLink}>
            {track.title}
          </Link>
        ) : (
          <h3 className={styles.title}>{track.title}</h3>
        )}
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
