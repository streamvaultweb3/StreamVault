import { useState, useEffect } from 'react';
import { useWallet } from '../../context/WalletContext';
import { searchTracksOnAO } from '../../lib/aoMusicRegistry';
import { aoRecordsToTracks } from '../../lib/arweaveDiscovery';
import { TrackCard } from '../../components/TrackCard';
import { Link } from 'react-router-dom';
import type { Track } from '../../context/PlayerContext';
import styles from './Vault.module.css';

export function VaultLibrary() {
  const { address } = useWallet();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tracks' | 'samples'>('tracks');

  useEffect(() => {
    if (!address) {
      setTracks([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    searchTracksOnAO({ creator: address })
      .then((records) => {
        if (!cancelled) setTracks(aoRecordsToTracks(records));
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message ?? 'Failed to load library.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [address]);

  return (
    <>
      <h1 className={styles.sectionTitle}>Library</h1>
      <p className={styles.sectionSubtitle}>
        Your uploads from the AO Music Registry. Samples are on your{' '}
        <Link to={address ? `/profile/${address}` : '#'} style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
          profile
        </Link>.
      </p>
      {!address ? (
        <p className={styles.placeholderBox}>Connect your wallet to see your library.</p>
      ) : (
        <>
          <div className={styles.tabRow}>
            <button
              type="button"
              className={activeTab === 'tracks' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setActiveTab('tracks')}
            >
              Tracks
            </button>
            <button
              type="button"
              className={activeTab === 'samples' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
              onClick={() => setActiveTab('samples')}
            >
              My samples
            </button>
          </div>
          {activeTab === 'samples' ? (
            <p className={styles.placeholderBox}>
              Samples are stored on your Arweave profile. View them on your{' '}
              <Link to={`/profile/${address}`}>Profile</Link>.
            </p>
          ) : (
            <>
              {error && <p className={styles.errorText}>{error}</p>}
              {loading ? (
                <p className={styles.loading}>Loading…</p>
              ) : (
                <section className={styles.grid}>
                  {tracks.map((track) => (
                    <TrackCard
                      key={track.id}
                      track={track}
                      artistHref={`/profile/${address}`}
                    />
                  ))}
                </section>
              )}
              {!loading && !error && tracks.length === 0 && (
                <p className={styles.placeholderBox}>You have not published any full tracks yet. Use Upload to publish an atomic asset.</p>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
