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
import { PublishModal } from '../components/PublishModal';
import styles from './Home.module.css';
import { useWallet } from '../context/WalletContext';
import { usePermaweb } from '../context/PermawebContext';
import { CreateProfileModal } from '../components/CreateProfileModal';
import { getSelectedOrLatestProfileByWallet } from '../lib/permaProfile';

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
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [publishTrack, setPublishTrack] = useState<Track | null>(null);
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
      setLoading(true);
      try {
        const data = await getTrendingTracks(24);
        if (!cancelled) setTracks(data.map(mapAudiusToTrack));
      } catch (e) {
        if (!cancelled) setTracks([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
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
      <section className={styles.audiusSection}>
        <div className={styles.audiusHeader}>
          <div>
            <h2 className={styles.sectionTitle}>Audius profiles</h2>
            <p className={styles.sectionSubtitle}>
              Load an artist profile, playlists, and tracks by handle or URL.
            </p>
          </div>
          <div className={styles.audiusSearch}>
            <input
              className={styles.audiusInput}
              value={audiusQuery}
              onChange={(e) => setAudiusQuery(e.target.value)}
              placeholder="artist handle or audius.co/username"
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
                      <TrackCard key={track.id} track={track} onPublishClick={() => setPublishTrack(track)} />
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
                <TrackCard key={track.id} track={track} onPublishClick={() => setPublishTrack(track)} />
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
        <section className={styles.grid}>
          {tracks.map((track) => (
            <TrackCard
              key={track.id}
              track={track}
              onPublishClick={() => setPublishTrack(track)}
            />
          ))}
        </section>
      )}

      {publishTrack && (
        <PublishModal
          track={publishTrack}
          onClose={() => setPublishTrack(null)}
          onSuccess={() => setPublishTrack(null)}
        />
      )}
    </div>
  );
}
