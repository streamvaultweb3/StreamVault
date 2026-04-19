import { usePlayer } from '../context/PlayerContext';
import styles from './NowPlayingBar.module.css';

export function NowPlayingBar() {
  const { currentTrack, isPlaying, progress, toggle, seek } = usePlayer();

  if (!currentTrack) return null;

  return (
    <div className={styles.bar + ' glass-strong'}>
      <div className={styles.trackInfo}>
        {currentTrack.artwork ? (
          <img src={currentTrack.artwork} alt="" className={styles.artwork} />
        ) : (
          <div className={styles.artworkPlaceholder} aria-hidden="true" />
        )}
        <div className={styles.meta}>
          <span className={styles.title}>{currentTrack.title}</span>
          <span className={styles.artist}>{currentTrack.artist}</span>
        </div>
      </div>
      <div className={styles.controls}>
        <button type="button" className={styles.playBtn} onClick={toggle} aria-label={isPlaying ? 'Pause' : 'Play'}>
          {isPlaying ? (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          ) : (
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          )}
        </button>
        <div className={styles.progressWrap}>
          <input
            type="range"
            min={0}
            max={100}
            value={progress}
            onChange={(e) => seek(Number(e.target.value))}
            className={styles.progress}
          />
        </div>
      </div>
      <div className={styles.badges}>
        {currentTrack.isPermanent && (
          <span className={styles.permaBadge} title="Stored on Arweave">On Arweave</span>
        )}
      </div>
    </div>
  );
}
