import { useState, useEffect, useMemo } from 'react';
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
import { queryPermanentUploads } from '../lib/arweaveDiscovery';
import { uploadedTrackToPlayerTrack, type UploadedTrackRecord } from '../lib/uploadedTracks';
import { useAudiusAuth } from '../context/AudiusAuthContext';
import { PublishModal } from '../components/PublishModal';
import {
  fetchSpotifyCatalogSearch,
  spotifyTrackArtUrl,
  spotifyTrackArtistsLabel,
  spotifyTrackOpenUrl,
  type SpotifyCatalogTrack,
} from '../lib/spotify';

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

export function Home() {
  const { address, walletType } = useWallet();
  const { libs, isReady } = usePermaweb();
  const {
    audiusUser: connectedAudiusUser,
    login: audiusLogin,
    logout: audiusLogout,
    apiKeyConfigured,
    isLoggingIn: isAudiusLoggingIn,
    authError: audiusAuthError,
  } = useAudiusAuth();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [permanentTracks, setPermanentTracks] = useState<UploadedTrackRecord[]>([]);
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
  const [spotifyQuery, setSpotifyQuery] = useState('');
  const [spotifyResults, setSpotifyResults] = useState<SpotifyCatalogTrack[]>([]);
  const [spotifyLoading, setSpotifyLoading] = useState(false);
  const [spotifyError, setSpotifyError] = useState<string | null>(null);

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

    for (const upload of permanentTracks) {
      if (isFeedTestTrack(upload.title)) continue;
      const key = `ar:${upload.txId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const borrowedArtwork =
        upload.artworkUrl ||
        audiusArtworkByKey.get(`${upload.title.trim().toLowerCase()}::${upload.artist.trim().toLowerCase()}`);
      merged.push({
        key,
        track: {
          ...uploadedTrackToPlayerTrack(upload),
          artwork: borrowedArtwork || uploadedTrackToPlayerTrack(upload).artwork,
        },
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
  }, [permanentTracks, tracks]);

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

  const handleSpotifySearch = async () => {
    const q = spotifyQuery.trim();
    if (!q) {
      setSpotifyResults([]);
      setSpotifyError(null);
      return;
    }
    setSpotifyLoading(true);
    setSpotifyError(null);
    try {
      const data = await fetchSpotifyCatalogSearch(q, { type: 'track' });
      setSpotifyResults(data.tracks?.items ?? []);
    } catch (e: unknown) {
      setSpotifyResults([]);
      setSpotifyError(e instanceof Error ? e.message : 'Spotify search failed.');
    } finally {
      setSpotifyLoading(false);
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
    if (!libs?.createProfile || !address || walletType !== 'arweave') return;
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
      const args: any = {
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        description: form.description.trim(),
      };
      if (form.thumbnail) args.thumbnail = await fileToDataURL(form.thumbnail);
      if (form.banner) args.banner = await fileToDataURL(form.banner);
      const profileId = await libs.createProfile(args);
      console.info('[profile] create success', { profileId });
      if (profileId && libs.updateZone) {
        const update: Record<string, string> = {
          Name: form.displayName.trim(),
          Handle: form.username.trim(),
          Bio: form.description.trim(),
        };
        if (form.audiusHandle) update.AudiusHandle = form.audiusHandle;
        await libs.updateZone(update, profileId);
        console.info('[profile] profile updated', { profileId });
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
      setPermanentLoading(true);
      try {
        const rows = await queryPermanentUploads({ limit: 12 });
        if (!cancelled) setPermanentTracks(rows);
      } catch {
        if (!cancelled) setPermanentTracks([]);
      } finally {
        if (!cancelled) setPermanentLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
          Connect Audius to import metadata, search the public Spotify catalog for references, then upload audio + art to
          Arweave.
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

      {loading || permanentLoading ? (
        <LogoSpinner />
      ) : (
        <>
          <section className={styles.grid}>
            {discoverTracks.map((item) => (
              <TrackCard
                key={item.key}
                track={item.track}
                artistHref={
                  item.kind === 'arweave' && item.upload?.walletAddress
                    ? `/profile/${item.upload.walletAddress}`
                    : undefined
                }
                showPermanentBadge={false}
                footerContent={
                  item.kind === 'arweave' && item.upload ? (
                    <>
                      <span className={styles.sourcePill}>Arweave</span>
                      <UploadedTrackMeta track={item.upload} compact />
                    </>
                  ) : (
                    <span className={styles.sourcePill}>Audius</span>
                  )
                }
              />
            ))}
          </section>
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

      <section className={styles.audiusSection} style={{ marginTop: '32px' }}>
        <div className={styles.audiusHeader}>
          <div className={styles.audiusIntro}>
            <h2 className={styles.sectionTitle}>Spotify catalog search</h2>
            <p className={styles.sectionSubtitle}>
              Search public tracks (app-only token on the server). Use results as reference links; audio still uploads from
              your files to Arweave.
            </p>
          </div>
          <div className={styles.audiusSearch}>
            <input
              className={styles.audiusInput}
              value={spotifyQuery}
              onChange={(e) => setSpotifyQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleSpotifySearch();
              }}
              placeholder="Track or artist name"
            />
            <button
              type="button"
              className={styles.audiusBtn}
              onClick={() => void handleSpotifySearch()}
              disabled={spotifyLoading || !spotifyQuery.trim()}
            >
              {spotifyLoading ? 'Searching…' : 'Search'}
            </button>
          </div>
        </div>

        {spotifyError && <p className={styles.errorText}>{spotifyError}</p>}

        {spotifyResults.length > 0 && (
          <div className={styles.importGrid}>
            {spotifyResults.map((track) => {
              const art = spotifyTrackArtUrl(track);
              const openUrl = spotifyTrackOpenUrl(track);
              return (
                <div key={track.id} className={styles.importCard}>
                  <div className={styles.importThumb}>
                    {art ? <img src={art} alt="" loading="lazy" /> : null}
                  </div>
                  <div className={styles.importMeta}>
                    <div className={styles.importTitle} title={track.name}>
                      {track.name}
                    </div>
                    <div className={styles.importSubtitle} title={track.album?.name}>
                      {spotifyTrackArtistsLabel(track)}
                      {track.album?.name ? ` · ${track.album.name}` : ''}
                    </div>
                    {openUrl && (
                      <a className={styles.importLink} href={openUrl} target="_blank" rel="noopener noreferrer">
                        Open in Spotify
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
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
