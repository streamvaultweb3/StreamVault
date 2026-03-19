import { useState, useEffect } from 'react';
import { fetchTrendingTracks } from '../../lib/arweaveDiscovery';
import { TrackCard } from '../../components/TrackCard';
import { LogoSpinner } from '../../components/LogoSpinner';
import type { Track } from '../../context/PlayerContext';
import styles from './Vault.module.css';

export function VaultTrending() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTrendingTracks(32)
      .then((data) => {
        if (!cancelled) setTracks(data);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message ?? 'Failed to load trending tracks.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <h1 className={styles.sectionTitle}>Trending</h1>
      <p className={styles.sectionSubtitle}>
        Latest audio on Arweave from StreamVault and the AO Music Registry.
      </p>
      {error && <p className={styles.errorText}>{error}</p>}
      {loading ? (
        <LogoSpinner />
      ) : (
        <section className={styles.grid}>
          {tracks.map((track) => (
            <TrackCard
              key={track.id}
              track={track}
              artistHref={track.artistId && track.artistId.length > 20 ? `/profile/${track.artistId}` : undefined}
            />
          ))}
        </section>
      )}
      {!loading && !error && tracks.length === 0 && (
        <p className={styles.placeholderBox}>No tracks yet. Upload your first track to get started.</p>
      )}
    </>
  );
}
