import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  getTrendingTracks,
  getStreamUrl,
  getArtworkUrl,
  searchUsers,
  getUserById,
  getUserByHandle,
  getUserPlaylists,
  getUserTracks,
  getPlaylistTracks,
  type AudiusTrack,
  type AudiusPlaylist,
  type AudiusUser,
} from '../lib/audius';
import type { Track } from '../context/PlayerContext';
import { TrackCard } from '../components/TrackCard';
import { UploadedTrackMeta } from '../components/UploadedTrackMeta';
import { LogoSpinner } from '../components/LogoSpinner';
import styles from './Home.module.css';
import { useWallet } from '../context/WalletContext';
import { usePermaweb } from '../context/PermawebContext';
import { CreateProfileModal } from '../components/CreateProfileModal';
import { getSelectedOrLatestProfileByWallet } from '../lib/permaProfile';
import {
  applyProfileZoneExtras,
  buildPermawebProfileArgs,
  connectArweaveSignerForProfile,
  getWritableProfileLibs,
  resolveArweaveSigner,
} from '../lib/profileWrite';
import { useApi } from '@arweave-wallet-kit/react';
import { arweaveArtistPath, looksLikeWalletAddress } from '../lib/arweaveArtist';
import { arweaveTxDataUrl } from '../lib/arweaveDataGateway';
import { fetchTrendingTracks, fetchAtomicAssetMap, enrichTracksWithAtomicAssetIds } from '../lib/arweaveDiscovery';
import { type UploadedTrackRecord, uploadedTrackCompactBadges } from '../lib/uploadedTracks';
import { ATOMIC_ASSET_BADGE } from '../lib/trackBadges';
import { fetchStreamVaultMarketplaceListings, type MarketplaceListing } from '../lib/ucmMarketplace';
import { trackDetailPath } from '../lib/arweaveTxDetail';
import { bazarAssetUrl } from '../lib/ucm';
import { findUploadLedgerByTxId } from '../lib/uploadLedger';
import { useAudiusAuth } from '../context/AudiusAuthContext';
import { PublishModal } from '../components/PublishModal';

function mapAudiusToTrack(a: AudiusTrack): Track {
  return {
    id: a.id,
    title: a.title,
    artist: a.user.name,
    artistId: a.user.id,
    artwork: getArtworkUrl(a) || undefined,
    streamUrl: getStreamUrl(a),
    duration: a.duration,
  };
}

function arweaveTrackToUploadRecord(track: Track): UploadedTrackRecord {
  const txId = track.permaTxId || track.id;
  let artworkTxId: string | undefined;
  let artworkUrl: string | undefined;
  if (track.artwork) {
    if (track.artwork.includes('/')) {
      artworkUrl = track.artwork;
      const match = track.artwork.match(/[A-Za-z0-9_-]{43}/);
      if (match) artworkTxId = match[0];
    } else if (track.artwork.length === 43) {
      artworkTxId = track.artwork;
      artworkUrl = arweaveTxDataUrl(track.artwork);
    } else {
      artworkUrl = track.artwork;
    }
  }
  return {
    txId,
    title: track.title,
    artist: track.artist,
    permawebUrl: arweaveTxDataUrl(txId),
    createdAt: new Date(0).toISOString(),
    walletAddress:
      track.artistId && looksLikeWalletAddress(track.artistId) ? track.artistId : undefined,
    assetId: track.assetId,
    artworkTxId,
    artworkUrl,
  };
}

export function Home() {
  const { address, walletType } = useWallet();
  const { libs, isReady, getWritableLibs } = usePermaweb();
  const arweaveApi = useApi();
  const {
    audiusUser: connectedAudiusUser,
    login: audiusLogin,
    logout: audiusLogout,
    apiKeyConfigured,
    isLoggingIn: isAudiusLoggingIn,
    authError: audiusAuthError,
  } = useAudiusAuth();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [arweaveDiscoverTracks, setArweaveDiscoverTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [permanentLoading, setPermanentLoading] = useState(true);
  const [discoverLimit, setDiscoverLimit] = useState(24);
  const [discoverLoadingMore, setDiscoverLoadingMore] = useState(false);
  const [audiusQuery, setAudiusQuery] = useState('');
  const [audiusUser, setAudiusUser] = useState<AudiusUser | null>(null);
  const [audiusPlaylists, setAudiusPlaylists] = useState<AudiusPlaylist[]>([]);
  const [audiusTracks, setAudiusTracks] = useState<Track[]>([]);
  const [audiusLoading, setAudiusLoading] = useState(false);
  const [audiusError, setAudiusError] = useState<string | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<Record<string, Track[]>>({});
  const [playlistLoading, setPlaylistLoading] = useState<Record<string, boolean>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [hasPermaProfile, setHasPermaProfile] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [atomicAssetByAudioTx, setAtomicAssetByAudioTx] = useState<Record<string, string>>({});
  const [marketListings, setMarketListings] = useState<MarketplaceListing[]>([]);
  const [marketLoading, setMarketLoading] = useState(true);

  const discoverTracks = useMemo(() => {
    const isFeedTestTrack = (title: string) => title.toLowerCase().includes('test');
    const audiusArtworkByKey = new Map<string, string>();
    for (const track of tracks) {
      if (!track.artwork) continue;
      audiusArtworkByKey.set(`${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`, track.artwork);
    }
    const merged: Array<{
      key: string;
      track: Track;
      kind: 'arweave' | 'audius';
      upload?: UploadedTrackRecord;
    }> = [];
    const seen = new Set<string>();

    for (const arTrack of arweaveDiscoverTracks) {
      if (isFeedTestTrack(arTrack.title)) continue;
      const txId = arTrack.permaTxId || arTrack.id;
      const key = `ar:${txId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ledgerHit = findUploadLedgerByTxId(txId);
      const assetId =
        arTrack.assetId || ledgerHit?.assetId || atomicAssetByAudioTx[txId] || undefined;
      const trackWithAsset = {
        ...arTrack,
        assetId,
      };
      const upload: UploadedTrackRecord = {
        ...arweaveTrackToUploadRecord(trackWithAsset),
        assetId,
      };
      const borrowedArtwork =
        arTrack.artwork ||
        audiusArtworkByKey.get(`${arTrack.title.trim().toLowerCase()}::${arTrack.artist.trim().toLowerCase()}`);
      merged.push({
        key,
        track: { ...trackWithAsset, artwork: borrowedArtwork || arTrack.artwork },
        kind: 'arweave',
        upload,
      });
    }

    for (const track of tracks) {
      if (isFeedTestTrack(track.title)) continue;
      const key = `au:${track.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        key,
        track,
        kind: 'audius',
      });
    }

    return merged;
  }, [arweaveDiscoverTracks, atomicAssetByAudioTx, tracks]);

  const mapAudiusTrack = (a: AudiusTrack): Track => ({
    id: a.id,
    title: a.title,
    artist: a.user.name,
    artistId: a.user.id,
    artwork: getArtworkUrl(a) || undefined,
    streamUrl: getStreamUrl(a),
    duration: a.duration,
  });

  const parseAudiusInput = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return { id: null, handle: null };
    try {
      if (trimmed.includes('audius.co')) {
        const url = new URL(trimmed);
        const path = url.pathname.split('/').filter(Boolean);
        const handle = path[0];
        return { id: null, handle: handle?.replace('@', '') || null };
      }
    } catch {
      // ignore
    }
    return { id: trimmed, handle: trimmed.startsWith('@') ? trimmed.slice(1) : trimmed };
  };

  const handleLoadAudius = async () => {
    const { id, handle } = parseAudiusInput(audiusQuery);
    if (!id && !handle) return;
    setAudiusLoading(true);
    setAudiusError(null);
    setAudiusUser(null);
    setAudiusPlaylists([]);
    setAudiusTracks([]);
    try {
      let user: AudiusUser | null = null;
      if (id && id.length >= 10) {
        user = await getUserById(id);
      }
      if (!user && handle) {
        user = await getUserByHandle(handle);
      }
      if (!user && handle) {
        const results = await searchUsers(handle, 1);
        user = results[0] || null;
      }
      if (!user) throw new Error('No matching Audius profile found.');
      setAudiusUser(user);
      const [playlists, tracksData] = await Promise.all([
        getUserPlaylists(user.id, 12),
        getUserTracks(user.id, 12),
      ]);
      setAudiusPlaylists(playlists);
      setAudiusTracks(tracksData.map(mapAudiusTrack));
    } catch (e: any) {
      setAudiusError(e?.message || 'Failed to load Audius profile.');
    } finally {
      setAudiusLoading(false);
    }
  };

  const handleLoadPlaylistTracks = async (playlistId: string) => {
    if (playlistTracks[playlistId]) return;
    setPlaylistLoading((prev) => ({ ...prev, [playlistId]: true }));
    try {
      const data = await getPlaylistTracks(playlistId, 12);
      setPlaylistTracks((prev) => ({
        ...prev,
        [playlistId]: data.map(mapAudiusTrack),
      }));
    } catch (e: any) {
      setAudiusError(e?.message || 'Failed to load playlist tracks.');
    } finally {
      setPlaylistLoading((prev) => ({ ...prev, [playlistId]: false }));
    }
  };

  const fileToDataURL = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  };

  const handleCreateProfile = async (form: {
    username: string;
    displayName: string;
    description: string;
    audiusHandle?: string;
    thumbnail?: File | null;
    banner?: File | null;
    thumbnailValue?: string | null;
    bannerValue?: string | null;
    removeThumbnail?: boolean;
    removeBanner?: boolean;
  }) => {
    if (!libs || !address || walletType !== 'arweave') return;
    setCreating(true);
    setCreateError(null);
    try {
      console.info('[profile] create start', { address, audiusHandle: form.audiusHandle });
      const existing = await getSelectedOrLatestProfileByWallet(libs, address);
      if (existing?.id) {
        console.info('[profile] existing profile found', { profileId: existing.id });
        setCreateError('Profile already exists for this wallet. Open your profile to view it.');
        setCreateOpen(false);
        return;
      }
      const signerWallet = resolveArweaveSigner(arweaveApi);
      if (!signerWallet) throw new Error('Arweave signer unavailable. Connect Wander and retry.');
      await connectArweaveSignerForProfile(signerWallet);
      const writableLibs = await getWritableProfileLibs(getWritableLibs);
      const args = await buildPermawebProfileArgs(form, fileToDataURL, writableLibs);
      const profileId = await writableLibs.createProfile(args);
      console.info('[profile] create success', { profileId });
      if (!profileId) throw new Error('permaweb-libs createProfile returned no profile id.');
      if (form.audiusHandle?.trim()) {
        await applyProfileZoneExtras(writableLibs, profileId, {
          audiusHandle: form.audiusHandle.trim(),
        });
      }
      setCreateOpen(false);
    } catch (e: any) {
      console.error('[profile] create failed', e);
      const msg = String(e?.message || '');
      if (msg.includes('not allowed on this SU') || (msg.includes('Process') && msg.includes('not allowed'))) {
        setCreateError('Permaweb profile creation is not available on this node. Try an AO mainnet-enabled environment.');
      } else {
        setCreateError(msg || 'Profile creation failed');
      }
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPermanentLoading(true);
      try {
        const assetMap = await fetchAtomicAssetMap({ limit: 100 });
        if (cancelled) return;
        setAtomicAssetByAudioTx(Object.fromEntries(assetMap));
        const rows = await fetchTrendingTracks(24);
        const enriched = await enrichTracksWithAtomicAssetIds(rows, assetMap);
        if (!cancelled) setArweaveDiscoverTracks(enriched);
      } catch {
        if (!cancelled) setArweaveDiscoverTracks([]);
      } finally {
        if (!cancelled) setPermanentLoading(false);
      }
    })();
    const onUploads = () => {
      void (async () => {
        const assetMap = await fetchAtomicAssetMap({ limit: 100 });
        setAtomicAssetByAudioTx(Object.fromEntries(assetMap));
        setArweaveDiscoverTracks((prev) => {
          void enrichTracksWithAtomicAssetIds(prev, assetMap).then(setArweaveDiscoverTracks);
          return prev;
        });
      })();
    };
    window.addEventListener('streamvault:uploads-updated', onUploads);
    return () => {
      cancelled = true;
      window.removeEventListener('streamvault:uploads-updated', onUploads);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadMarket = async () => {
      setMarketLoading(true);
      try {
        const rows = await fetchStreamVaultMarketplaceListings(12);
        if (!cancelled) setMarketListings(rows);
      } catch {
        if (!cancelled) setMarketListings([]);
      } finally {
        if (!cancelled) setMarketLoading(false);
      }
    };
    void loadMarket();
    const onUpdate = () => void loadMarket();
    window.addEventListener('streamvault:marketplace-updated', onUpdate);
    return () => {
      cancelled = true;
      window.removeEventListener('streamvault:marketplace-updated', onUpdate);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (discoverLimit <= 24) setLoading(true);
      else setDiscoverLoadingMore(true);
      try {
        const data = await getTrendingTracks(discoverLimit);
        if (!cancelled) setTracks(data.map(mapAudiusToTrack));
      } catch (e) {
        if (!cancelled) setTracks([]);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setDiscoverLoadingMore(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [discoverLimit]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isReady || !libs || !address || walletType !== 'arweave') {
        setHasPermaProfile(false);
        return;
      }
      try {
        const profile = await getSelectedOrLatestProfileByWallet(libs, address);
        if (!cancelled) setHasPermaProfile(Boolean(profile?.id));
      } catch {
        if (!cancelled) setHasPermaProfile(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isReady, libs, address, walletType]);

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>StreamVault</h1>
        <p className={styles.heroSubtitle}>
          Connect Audius to import metadata, then upload audio + art to Arweave.
        </p>
        <div className={styles.heroCtas}>
          <div className={styles.audiusConnectCard}>
            <div className={styles.audiusConnectText}>
              <strong>
                {connectedAudiusUser ? `Audius connected — @${connectedAudiusUser.handle}` : 'Connect Audius'}
              </strong>
              <span>
                {connectedAudiusUser
                  ? 'Imports are ready.'
                  : apiKeyConfigured
                    ? 'Import tracks + cover art into StreamVault.'
                    : 'Set VITE_AUDIUS_API_KEY to enable imports.'}
              </span>
            </div>
            {connectedAudiusUser ? (
              <button type="button" className={styles.heroSecondaryBtn} onClick={audiusLogout}>
                Disconnect
              </button>
            ) : (
              <button
                type="button"
                className={styles.heroSecondaryBtn}
                onClick={audiusLogin}
                disabled={!apiKeyConfigured || isAudiusLoggingIn}
                title={!apiKeyConfigured ? 'Missing VITE_AUDIUS_API_KEY' : undefined}
              >
                {isAudiusLoggingIn ? 'Connecting…' : 'Connect Audius'}
              </button>
            )}
          </div>

          <button type="button" className={styles.heroPrimaryBtn} onClick={() => setPublishOpen(true)}>
            Upload to Arweave
          </button>
        </div>

        {audiusAuthError && <p className={styles.errorText}>{audiusAuthError}</p>}
      </section>

      {loading && discoverTracks.length === 0 ? (
        <LogoSpinner />
      ) : (
        <>
          {permanentLoading && discoverTracks.length === 0 && (
            <p className={styles.sectionSubtitle}>Loading permanent uploads…</p>
          )}
          <section className={styles.grid}>
            {discoverTracks.map((item) => (
              <TrackCard
                key={item.key}
                track={item.track}
                artistHref={
                  item.kind === 'arweave' && item.upload?.walletAddress
                    ? arweaveArtistPath(item.upload.walletAddress)
                    : item.kind === 'arweave' &&
                        item.track.artistId &&
                        looksLikeWalletAddress(item.track.artistId)
                      ? arweaveArtistPath(item.track.artistId)
                      : undefined
                }
                showPermanentBadge={false}
                footerContent={
                  item.kind === 'arweave' && item.upload ? (
                    <div className={styles.discoverFooterStack}>
                      <div className={styles.discoverBadgeRow}>
                        <span className={styles.sourcePill}>Arweave</span>
                        {uploadedTrackCompactBadges({
                          ...item.upload,
                          assetId: item.upload.assetId || item.track.assetId,
                        }).map((badge) => (
                          <span key={badge} className={styles.sourcePill}>
                            {badge}
                          </span>
                        ))}
                      </div>
                      <UploadedTrackMeta track={item.upload} compact hideBadges />
                    </div>
                  ) : (
                    <span className={styles.sourcePill}>Audius</span>
                  )
                }
              />
            ))}
          </section>

          {(marketLoading || marketListings.length > 0) && (
            <section className={styles.marketSection}>
              <div className={styles.audiusHeader}>
                <div className={styles.audiusIntro}>
                  <h2 className={styles.sectionTitle}>Listed on UCM</h2>
                  <p className={styles.sectionSubtitle}>
                    StreamVault atomic assets with active sell orders on the Universal Content Marketplace.
                  </p>
                </div>
              </div>
              {marketLoading ? (
                <LogoSpinner />
              ) : (
                <div className={styles.grid}>
                  {marketListings.map((listing) => (
                    <TrackCard
                      key={listing.orderId}
                      track={listing.track}
                      titleHref={trackDetailPath(listing.audioTxId)}
                      artistHref={
                        listing.track.artistId && looksLikeWalletAddress(listing.track.artistId)
                          ? arweaveArtistPath(listing.track.artistId)
                          : undefined
                      }
                      showPermanentBadge={false}
                      footerContent={
                        <div className={styles.discoverFooterStack}>
                          <div className={styles.discoverBadgeRow}>
                            <span className={styles.sourcePill}>
                              {listing.priceDisplay} {listing.quoteSymbol}
                            </span>
                            <span className={styles.sourcePill}>{ATOMIC_ASSET_BADGE}</span>
                            <span className={styles.sourcePill}>UCM</span>
                          </div>
                          <div className={styles.marketLinks}>
                            <Link to={trackDetailPath(listing.audioTxId)} className={styles.marketLink}>
                              Details
                            </Link>
                            <a
                              href={bazarAssetUrl(listing.assetId)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={styles.marketLink}
                            >
                              Bazar
                            </a>
                          </div>
                        </div>
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          )}

          <div className={styles.audiusCta} style={{ marginTop: '16px' }}>
            <div>
              <p className={styles.ctaTitle}>More from Discover</p>
              <p className={styles.ctaCopy}>Load additional tracks from Audius trending.</p>
            </div>
            <button
              type="button"
              className={styles.ctaBtn}
              onClick={() => setDiscoverLimit((n) => n + 24)}
              disabled={discoverLoadingMore}
            >
              {discoverLoadingMore ? 'Loading more…' : 'Load more music'}
            </button>
          </div>
        </>
      )}

      <section className={styles.audiusSection} style={{ marginTop: '32px' }}>
        <div className={styles.audiusHeader}>
          <div className={styles.audiusIntro}>
            <h2 className={styles.sectionTitle}>Browse Audius</h2>
            <p className={styles.sectionSubtitle}>
              Load an artist profile, playlists, and tracks by handle or URL. Publishing is owner-only in Vault.
            </p>
          </div>
          <div className={styles.audiusSearch}>
            <input
              className={styles.audiusInput}
              value={audiusQuery}
              onChange={(e) => setAudiusQuery(e.target.value)}
              placeholder="Search Audius by handle or paste audius.co/username"
            />
            <button
              type="button"
              className={styles.audiusBtn}
              onClick={handleLoadAudius}
              disabled={audiusLoading || !audiusQuery.trim()}
            >
              {audiusLoading ? 'Loading…' : 'Load'}
            </button>
          </div>
        </div>

        {audiusError && <p className={styles.errorText}>{audiusError}</p>}

        {audiusUser && (
          <div className={styles.audiusProfile}>
            <div className={styles.audiusProfileMeta}>
              <span className={styles.audiusName}>{audiusUser.name}</span>
              <span className={styles.audiusHandle}>@{audiusUser.handle}</span>
            </div>
            <div className={styles.audiusStats}>
              <span>{audiusUser.track_count} tracks</span>
              {typeof audiusUser.playlist_count === 'number' && (
                <span>{audiusUser.playlist_count} playlists</span>
              )}
              {typeof audiusUser.follower_count === 'number' && (
                <span>{audiusUser.follower_count} followers</span>
              )}
            </div>
          </div>
        )}

        {!hasPermaProfile && (
          <div className={styles.experimentalCta}>
            <div className={styles.experimentalText}>
              <div className={styles.experimentalTitleRow}>
                <p className={styles.ctaTitle}>Bridge to permaweb</p>
                <span className={styles.experimentalBadge}>Experimental</span>
              </div>
              <p className={styles.ctaCopy}>
                Create an Arweave profile/zone to link identity and store uploads on-chain. This flow depends on evolving
                HyperBEAM + permaweb-libs behavior.
              </p>
              <p className={styles.ctaNote}>
                Profile/zone features may be unstable until the HyperBEAM/permaweb-libs changes settle.
              </p>
              {walletType && walletType !== 'arweave' && (
                <p className={styles.ctaNote}>
                  Arweave profile creation requires Wander. Other wallets can still publish via Turbo.
                </p>
              )}
            </div>
            <button
              type="button"
              className={styles.experimentalBtn}
              onClick={() => setCreateOpen(true)}
              disabled={walletType !== 'arweave'}
              title={walletType !== 'arweave' ? 'Connect Wander (Arweave) to create a profile' : undefined}
            >
              {walletType !== 'arweave' ? 'Connect Wander' : 'Create Arweave profile'}
            </button>
          </div>
        )}

        {createError && <p className={styles.errorText}>{createError}</p>}

        {audiusPlaylists.length > 0 && (
          <div className={styles.audiusPlaylists}>
            {audiusPlaylists.map((playlist) => (
              <div key={playlist.id} className={styles.playlistCard}>
                <div className={styles.playlistInfo}>
                  <div>
                    <p className={styles.playlistTitle}>{playlist.playlist_name}</p>
                    <p className={styles.playlistMeta}>{playlist.track_count} tracks</p>
                  </div>
                  <a
                    className={styles.playlistLink}
                    href={playlist.permalink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open on Audius
                  </a>
                </div>
                <button
                  type="button"
                  className={styles.playlistBtn}
                  onClick={() => handleLoadPlaylistTracks(playlist.id)}
                  disabled={playlistLoading[playlist.id]}
                >
                  {playlistLoading[playlist.id] ? 'Loading…' : 'Load tracks'}
                </button>
                {playlistTracks[playlist.id] && (
                  <div className={styles.playlistTracks}>
                    {playlistTracks[playlist.id].map((track) => (
                      <TrackCard key={track.id} track={track} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {audiusTracks.length > 0 && (
          <>
            <h3 className={styles.subsectionTitle}>Artist tracks</h3>
            <section className={styles.grid}>
              {audiusTracks.map((track) => (
                <TrackCard key={track.id} track={track} />
              ))}
            </section>
          </>
        )}
      </section>

      {createOpen && (
        <CreateProfileModal
          creating={creating}
          onClose={() => setCreateOpen(false)}
          onCreate={handleCreateProfile}
        />
      )}

      {publishOpen && (
        <PublishModal
          onClose={() => setPublishOpen(false)}
          onSuccess={() => setPublishOpen(false)}
        />
      )}
    </div>
  );
}
