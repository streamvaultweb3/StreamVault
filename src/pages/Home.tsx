import { useState, useEffect } from 'react';
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
import { LogoSpinner } from '../components/LogoSpinner';
import styles from './Home.module.css';
import { useWallet } from '../context/WalletContext';
import { usePermaweb } from '../context/PermawebContext';
import { CreateProfileModal } from '../components/CreateProfileModal';
import { getSelectedOrLatestProfileByWallet, setStoredProfileOverrideId } from '../lib/permaProfile';
import { createMainnetProfile } from '../lib/mainnetProfile';

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
  const { libs, isReady, getWritableLibs } = usePermaweb();
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
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
    if (!libs?.createProfile || !address || walletType !== 'arweave') return;
    setCreating(true);
    setCreateError(null);
    try {
      console.info('[profile] create start', { address, audiusHandle: form.audiusHandle });
      const args: any = {
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        description: form.description.trim(),
      };
      if (form.thumbnail) args.thumbnail = await fileToDataURL(form.thumbnail);
      if (form.banner) args.banner = await fileToDataURL(form.banner);
      const writableLibs = await getWritableLibs();
      if (!writableLibs) {
        throw new Error('Arweave writable profile client is not ready.');
      }
      const created = await createMainnetProfile(writableLibs, {
        username: args.username,
        displayName: args.displayName,
        description: args.description,
        audiusHandle: form.audiusHandle,
        thumbnail: args.thumbnail || null,
        banner: args.banner || null,
      });
      const { profileId } = created;
      console.info('[profile] create success', { profileId });
      setStoredProfileOverrideId(address, profileId);
      setHasPermaProfile(true);
      setCreateOpen(false);
    } catch (e: any) {
      console.error('[profile] create failed', e);
      const msg = String(e?.message || '');
      const isLocalhost =
        typeof window !== 'undefined' &&
        /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
      if (msg.includes('not allowed on this SU') || (msg.includes('Process') && msg.includes('not allowed'))) {
        setCreateError('Profile creation hit an AO network mismatch. The app is trying to create a mainnet profile through a non-mainnet scheduler unit.');
      } else if (
        isLocalhost &&
        (msg.includes('Error spawning process') ||
          msg.includes('HTTP request failed') ||
          msg.includes('Gateway Timeout') ||
          msg.includes('Failed to fetch'))
      ) {
        setCreateError('Mainnet profile creation from localhost is being blocked or timing out at the HyperBEAM transport layer. Test this same flow from a preview or production deployment instead of localhost.');
      } else if (msg.includes('Error spawning process')) {
        setCreateError('Mainnet profile spawning failed. This usually means the AO mainnet process constants or authority tags are mismatched.');
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
      if (!isReady || !libs || !address || walletType !== 'arweave') {
        setHasPermaProfile(false);
        return;
      }
      try {
        const profile = await getSelectedOrLatestProfileByWallet(libs, address, { useOverride: true });
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
      <section className={styles.audiusSection}>
        <div className={styles.audiusHeader}>
          <div className={styles.audiusIntro}>
            <h2 className={styles.sectionTitle}>Audius profiles</h2>
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
          <div className={styles.audiusCta}>
            <div>
              <p className={styles.ctaTitle}>Bridge to permaweb</p>
              <p className={styles.ctaCopy}>
                Create an Arweave profile to store your sound bites on-chain and link them to your Audius identity.
              </p>
              {walletType && walletType !== 'arweave' && (
                <p className={styles.ctaNote}>
                  Arweave profile creation requires Wander. Other wallets can still publish via Turbo.
                </p>
              )}
            </div>
            <button
              type="button"
              className={styles.ctaBtn}
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
          initialAudiusHandle={audiusUser?.handle}
          onCreate={handleCreateProfile}
        />
      )}
      <section className={styles.hero}>
        <h1 className={styles.heroTitle}>Discover</h1>
        <p className={styles.heroSubtitle}>
          Stream from the Open Audio Protocol. Publish forever on Arweave.
        </p>
      </section>

      {loading ? (
        <LogoSpinner />
      ) : (
        <>
          <section className={styles.grid}>
            {tracks.map((track) => (
              <TrackCard
                key={track.id}
                track={track}
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
    </div>
  );
}
