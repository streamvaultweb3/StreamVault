import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { TrackCard } from '../components/TrackCard';
import { UploadedTrackMeta } from '../components/UploadedTrackMeta';
import { LogoSpinner } from '../components/LogoSpinner';
import { fetchArweaveArtistPageData, arweaveArtistPath } from '../lib/arweaveArtist';
import type { UploadLedgerEntry } from '../lib/uploadLedger';
import type { Track } from '../context/PlayerContext';
import styles from './Artist.module.css';

export function ArweaveArtist() {
  const { address: rawAddress } = useParams<{ address: string }>();
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [uploads, setUploads] = useState<UploadLedgerEntry[]>([]);

  const uploadByTxId = useMemo(() => {
    const map = new Map<string, UploadLedgerEntry>();
    uploads.forEach((u) => map.set(u.txId, u));
    return map;
  }, [uploads]);

  useEffect(() => {
    if (!rawAddress?.trim()) {
      setLoading(false);
      setTracks([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await fetchArweaveArtistPageData(rawAddress);
        if (cancelled) return;
        setWalletAddress(data.walletAddress);
        setDisplayName(data.displayName);
        setTracks(data.tracks);
        setUploads(data.uploads);
      } catch {
        if (!cancelled) {
          setWalletAddress('');
          setDisplayName('');
          setTracks([]);
          setUploads([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rawAddress]);

  if (loading) return <LogoSpinner />;

  if (!rawAddress?.trim() || !walletAddress) {
    return <div className={styles.loading}>Artist not found.</div>;
  }

  const artistHref = arweaveArtistPath(walletAddress);

  return (
    <div className={styles.page}>
      <header className={styles.header + ' glass'}>
        <div className={styles.banner} />
        <div className={styles.profile}>
          <div className={styles.avatarPlaceholder} aria-hidden="true" />
          <div>
            <h1 className={styles.name}>{displayName}</h1>
            <p className={styles.handle} title={walletAddress}>
              {walletAddress.slice(0, 10)}…{walletAddress.slice(-8)}
            </p>
            <p className={styles.meta}>
              {tracks.length} permanent track{tracks.length === 1 ? '' : 's'} on Arweave
            </p>
            <p className={styles.meta}>
              <Link to={`/profile/${walletAddress}`}>View wallet profile</Link>
            </p>
          </div>
        </div>
      </header>

      <section className={styles.tracks}>
        <h2 className={styles.sectionTitle}>Tracks</h2>
        {tracks.length === 0 ? (
          <p className={styles.loading}>No published tracks found for this wallet yet.</p>
        ) : (
          <div className={styles.grid}>
            {tracks.map((track) => {
              const upload = uploadByTxId.get(track.permaTxId || track.id);
              return (
                <TrackCard
                  key={track.id}
                  track={track}
                  artistHref={artistHref}
                  showPermanentBadge={false}
                  footerContent={
                    upload ? (
                      <>
                        <span className={styles.meta}>Arweave</span>
                        <UploadedTrackMeta track={upload} compact />
                      </>
                    ) : (
                      <span className={styles.meta}>Arweave</span>
                    )
                  }
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
