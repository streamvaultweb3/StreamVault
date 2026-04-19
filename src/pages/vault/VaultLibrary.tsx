import { useEffect, useRef, useState } from 'react';
import { useWallet } from '../../context/WalletContext';
import { searchTracksOnAO } from '../../lib/aoMusicRegistry';
import { aoRecordsToTracks } from '../../lib/arweaveDiscovery';
import { TrackCard } from '../../components/TrackCard';
import { UploadedTrackMeta } from '../../components/UploadedTrackMeta';
import { Link } from 'react-router-dom';
import type { Track } from '../../context/PlayerContext';
import { useAudiusAuth } from '../../context/AudiusAuthContext';
import {
  getArtworkUrl,
  getStreamUrl,
  getUserAlbums,
  getUserByHandle,
  getUserPlaylists,
  getUserTracks,
  type AudiusAlbum,
  type AudiusPlaylist,
  type AudiusTrack,
} from '../../lib/audius';
import { PublishModal } from '../../components/PublishModal';
import { readUploadLedger } from '../../lib/uploadLedger';
import {
  matchUploadedTrackToAudiusTrack,
  normalizeUploadedTrackRecord,
  uploadedTrackToPlayerTrack,
  type UploadedTrackRecord,
} from '../../lib/uploadedTracks';
import styles from './Vault.module.css';

export function VaultLibrary() {
  const { address } = useWallet();
  const { audiusUser, login, apiKeyConfigured, isLoggingIn, authError } = useAudiusAuth();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [uploadedTracks, setUploadedTracks] = useState<UploadedTrackRecord[]>([]);
  const [audiusTracks, setAudiusTracks] = useState<Track[]>([]);
  const [audiusPlaylists, setAudiusPlaylists] = useState<AudiusPlaylist[]>([]);
  const [audiusAlbums, setAudiusAlbums] = useState<AudiusAlbum[]>([]);
  const [audiusLoading, setAudiusLoading] = useState(false);
  const [audiusError, setAudiusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [publishTrack, setPublishTrack] = useState<Track | null>(null);
  const [activeTab, setActiveTab] = useState<'tracks' | 'audius'>('tracks');
  const lastAutoOpenedAudiusHandleRef = useRef<string | null>(null);

  const mapAudiusTrack = (a: AudiusTrack): Track => ({
    id: a.id,
    title: a.title,
    artist: a.user?.name || a.user?.handle || audiusUser?.name || audiusUser?.handle || 'Unknown artist',
    artistId: a.user?.id || String(a.user_id || ''),
    artwork: getArtworkUrl(a) || undefined,
    streamUrl: getStreamUrl(a),
    duration: a.duration,
  });

  const toAudiusUrl = (permalink: string) =>
    permalink.startsWith('http://') || permalink.startsWith('https://')
      ? permalink
      : `https://audius.co${permalink.startsWith('/') ? '' : '/'}${permalink}`;

  const openAudiusLogin = () => {
    if (typeof window === 'undefined') return;
    window.open('https://audius.co/login', '_blank', 'noopener,noreferrer');
  };

  useEffect(() => {
    if (!address) {
      setTracks([]);
      setUploadedTracks([]);
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

  useEffect(() => {
    if (!address) {
      setUploadedTracks([]);
      return;
    }
    const reload = () => {
      const rows = readUploadLedger([address])
        .map((row) => normalizeUploadedTrackRecord(row))
        .filter(Boolean) as UploadedTrackRecord[];
      setUploadedTracks(
        rows
          .filter((row) => row.tier !== 'sample')
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      );
    };
    reload();
    window.addEventListener('streamvault:profile-updated', reload);
    window.addEventListener('streamvault:uploads-updated', reload);
    return () => {
      window.removeEventListener('streamvault:profile-updated', reload);
      window.removeEventListener('streamvault:uploads-updated', reload);
    };
  }, [address]);

  const uploadedLookup = new Map<string, UploadedTrackRecord>();
  for (const upload of uploadedTracks) {
    uploadedLookup.set(upload.txId, upload);
  }

  useEffect(() => {
    let cancelled = false;
    if (!audiusUser?.handle && !audiusUser?.userId && !audiusUser?.sub) {
      setAudiusTracks([]);
      setAudiusPlaylists([]);
      setAudiusAlbums([]);
      setAudiusLoading(false);
      setAudiusError(null);
      return;
    }
    setAudiusLoading(true);
    setAudiusError(null);
    (async () => {
      let resolvedUserId = String(audiusUser.userId || audiusUser.sub || '');
      if (!resolvedUserId || resolvedUserId === '0') {
        const byHandle = await getUserByHandle(audiusUser.handle);
        resolvedUserId = String(byHandle?.user_id || byHandle?.id || '');
      }
      if (!resolvedUserId) {
        throw new Error('Could not resolve your Audius user id from the connected account.');
      }
      const [rows, playlists, albums] = await Promise.all([
        getUserTracks(resolvedUserId, 50),
        getUserPlaylists(resolvedUserId, 25),
        getUserAlbums(resolvedUserId, 25),
      ]);
      if (cancelled) return;
      setAudiusTracks(rows.map(mapAudiusTrack));
      setAudiusPlaylists(playlists);
      setAudiusAlbums(albums);
    })()
      .catch((e: any) => {
        if (!cancelled) {
          setAudiusTracks([]);
          setAudiusPlaylists([]);
          setAudiusAlbums([]);
          setAudiusError(e?.message ?? 'Failed to load your Audius tracks.');
        }
      })
      .finally(() => {
        if (!cancelled) setAudiusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [audiusUser?.handle, audiusUser?.sub, audiusUser?.userId]);

  useEffect(() => {
    const handle = String(audiusUser?.handle || '').trim().toLowerCase();
    if (!handle) {
      lastAutoOpenedAudiusHandleRef.current = null;
      return;
    }
    if (lastAutoOpenedAudiusHandleRef.current === handle) return;
    lastAutoOpenedAudiusHandleRef.current = handle;
    setActiveTab('audius');
  }, [audiusUser?.handle]);

  return (
    <>
      <h1 className={styles.sectionTitle}>Library</h1>
      <p className={styles.sectionSubtitle}>
        Your uploads from the AO Music Registry. Samples are on your{' '}
        <Link to={address ? `/profile/${address}` : '#'} style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
          profile
        </Link>.
      </p>
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
          className={activeTab === 'audius' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
          onClick={() => setActiveTab('audius')}
        >
          My Audius tracks
        </button>
      </div>
      {activeTab === 'audius' ? (
        <>
          {!audiusUser ? (
            <div className={styles.placeholderBox}>
              <p>Connect your Audius account to load your tracks and publish your own catalog to Arweave.</p>
              <p className={styles.subtext} style={{ marginTop: '8px' }}>
                If your Audius account uses email/social login, open Audius first and sign in there before connecting.
              </p>
              {apiKeyConfigured ? (
                <div className={styles.connectAudiusRow}>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={openAudiusLogin}
                  >
                    Open Audius first
                  </button>
                  <button
                    type="button"
                    className={styles.searchBtn}
                    onClick={login}
                    disabled={isLoggingIn}
                  >
                    {isLoggingIn ? 'Connecting…' : 'Connect Audius'}
                  </button>
                </div>
              ) : (
                <p className={styles.errorText} style={{ marginTop: '12px' }}>
                  Audius login is not configured. Add `VITE_AUDIUS_API_KEY` (or `VITE_API`) in your env.
                </p>
              )}
              {authError && <p className={styles.errorText} style={{ marginTop: '12px' }}>{authError}</p>}
            </div>
          ) : (
            <>
              <p className={styles.sectionSubtitle}>Connected as @{audiusUser.handle}</p>
              {audiusError && <p className={styles.errorText}>{audiusError}</p>}
              {authError && <p className={styles.errorText}>{authError}</p>}
              {audiusLoading ? (
                <p className={styles.loading}>Loading your Audius tracks…</p>
              ) : (
                <>
                  {(audiusAlbums.length > 0 || audiusPlaylists.length > 0) && (
                    <div className={styles.walletCard} style={{ marginBottom: '16px', maxWidth: '100%' }}>
                      <p className={styles.sectionSubtitle} style={{ marginBottom: '10px' }}>Albums / playlists</p>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                        {audiusAlbums.map((album) => (
                          <a
                            key={`album-${album.id}`}
                            href={toAudiusUrl(album.permalink)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.tab}
                            style={{ textDecoration: 'none' }}
                          >
                            {album.playlist_name} ({album.track_count})
                          </a>
                        ))}
                        {audiusPlaylists.map((playlist) => (
                          <a
                            key={`playlist-${playlist.id}`}
                            href={toAudiusUrl(playlist.permalink)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.tab}
                            style={{ textDecoration: 'none' }}
                          >
                            {playlist.playlist_name} ({playlist.track_count})
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  <section className={styles.grid}>
                    {audiusTracks.map((track) => {
                      const matchedUpload = matchUploadedTrackToAudiusTrack(uploadedTracks, track);
                      return (
                        <TrackCard
                          key={track.id}
                          track={track}
                          onPublishClick={matchedUpload ? undefined : () => setPublishTrack(track)}
                          showPermanentBadge={false}
                          footerContent={
                            matchedUpload ? (
                              <>
                                <span className={styles.sourcePill}>Arweave</span>
                                <UploadedTrackMeta track={matchedUpload} compact />
                              </>
                            ) : (
                              <span className={styles.uploadHint}>Not uploaded to Arweave yet.</span>
                            )
                          }
                        />
                      );
                    })}
                  </section>
                </>
              )}
              {!audiusLoading && !audiusError && audiusTracks.length === 0 && (
                <p className={styles.placeholderBox}>
                  No tracks found on your Audius profile yet.
                </p>
              )}
            </>
          )}
        </>
      ) : !address ? (
        <p className={styles.placeholderBox}>Connect your wallet to see your on-chain library.</p>
      ) : (
        <>
          {activeTab === 'tracks' && audiusUser && (
            <div className={styles.walletCard} style={{ marginBottom: '16px', maxWidth: '100%' }}>
              <p className={styles.sectionSubtitle} style={{ marginBottom: '8px' }}>
                Audius connected as @{audiusUser.handle}
              </p>
              <p className={styles.subtext} style={{ marginBottom: '12px' }}>
                Your Audius albums, playlists, and tracks are available in the Audius tab.
              </p>
              <button
                type="button"
                className={styles.searchBtn}
                onClick={() => setActiveTab('audius')}
              >
                Open Audius library
              </button>
            </div>
          )}
          {error && <p className={styles.errorText}>{error}</p>}
          {loading ? (
            <p className={styles.loading}>Loading…</p>
          ) : (
            <>
              {uploadedTracks.length > 0 && (
                <section className={styles.grid} style={{ marginBottom: '24px' }}>
                  {uploadedTracks.map((track) => (
                    <TrackCard
                      key={track.txId}
                      track={uploadedTrackToPlayerTrack(track)}
                      artistHref={`/profile/${address}`}
                      showPermanentBadge={false}
                      footerContent={
                        <>
                          <span className={styles.sourcePill}>Arweave</span>
                          <UploadedTrackMeta track={track} compact />
                        </>
                      }
                    />
                  ))}
                </section>
              )}
              <section className={styles.grid}>
                {tracks.map((track) => {
                  const uploaded = uploadedLookup.get(track.permaTxId || track.id);
                  const displayTrack = uploaded
                    ? {
                        ...track,
                        artwork: uploaded.artworkUrl || track.artwork,
                      }
                    : track;
                  return (
                    <TrackCard
                      key={track.id}
                      track={displayTrack}
                      artistHref={`/profile/${address}`}
                      showPermanentBadge={false}
                      footerContent={
                        uploaded ? (
                          <>
                            <span className={styles.sourcePill}>Arweave</span>
                            <UploadedTrackMeta track={uploaded} compact />
                          </>
                        ) : undefined
                      }
                    />
                  );
                })}
              </section>
            </>
          )}
          {!loading && !error && tracks.length === 0 && uploadedTracks.length === 0 && (
            <p className={styles.placeholderBox}>You have not published any full tracks yet. Use Upload to publish an atomic asset.</p>
          )}
        </>
      )}
      {publishTrack && (
        <PublishModal
          track={publishTrack}
          onClose={() => setPublishTrack(null)}
          onSuccess={() => setPublishTrack(null)}
        />
      )}
    </>
  );
}
