import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { usePermaweb } from '../context/PermawebContext';
import { useAudiusAuth } from '../context/AudiusAuthContext';
import { type Track, usePlayer } from '../context/PlayerContext';
import { LogoSpinner } from '../components/LogoSpinner';
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
  type AudiusUser,
} from '../lib/audius';
import { CreateProfileModal } from '../components/CreateProfileModal';
import { type RegisteredTrackRecord, searchTracksOnAO } from '../lib/aoMusicRegistry';
import { getRoyaltyPayoutPlan } from '../lib/aoRoyaltyEngine';
import {
  clearStoredProfileOverrideId,
  getProfileAvatar,
  getProfileBanner,
  getProfileBio,
  getProfileDisplayName,
  getProfileHandle,
  inspectProfileReadState,
  getLatestProfileByWallet,
  getProfileOptionsByWallet,
  getProfileByIdSafe,
  getSelectedOrLatestProfileByWallet,
  getStoredProfileOverrideId,
  setStoredProfileOverrideId,
} from '../lib/permaProfile';
import { resolveProfileTokens, type ResolvedProfileToken } from '../lib/profileTokens';
import { PublishModal } from '../components/PublishModal';
import { useApi } from '@arweave-wallet-kit/react';
import { createMainnetProfile } from '../lib/mainnetProfile';
import styles from './Profile.module.css';

type PermaProfile = {
  id?: string | null;
  walletAddress?: string;
  username?: string;
  displayName?: string;
  description?: string;
  audiusHandle?: string;
  thumbnail?: string | null;
  banner?: string | null;
  thumbnailTxId?: string | null;
  bannerTxId?: string | null;
  assets?: any[];
};

type LocalSample = {
  txId: string;
  title: string;
  artist: string;
  permawebUrl?: string;
  arioUrl?: string;
  createdAt: string;
};

type ProfileOption = {
  id: string;
  timestamp?: number;
};

const PROFILE_CACHE = new Map<string, any>();
const PROFILE_OPTIONS_CACHE = new Map<string, ProfileOption[]>();
const PROFILE_TOKENS_CACHE = new Map<string, ResolvedProfileToken[]>();

function getProfileSnapshotKey(walletAddress: string) {
  return `streamvault:profileSnapshot:${walletAddress.toLowerCase()}`;
}

function inferProfileWalletAddress(profile: any, fallback?: string | null): string | null {
  const owner =
    profile?.walletAddress ||
    profile?.WalletAddress ||
    profile?.owner ||
    profile?.Owner ||
    null;
  if (typeof owner === 'string' && owner.trim()) return owner;
  if (fallback && typeof fallback === 'string' && fallback.trim()) return fallback;
  return null;
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export function Profile() {
  const navigate = useNavigate();
  const profileDebug = import.meta.env.DEV && String(import.meta.env.VITE_DEBUG_PROFILE || '') === '1';
  const profileLog = (...args: any[]) => {
    if (profileDebug) console.info(...args);
  };
  const { address: routeProfileRef } = useParams<{ address: string }>();
  const { address: connectedAddress, walletType } = useWallet();
  const { audiusUser, login, logout, apiKeyConfigured, isLoggingIn, authError: audiusAuthError } = useAudiusAuth();
  const { play, pause, currentTrack, isPlaying } = usePlayer();
  const arweaveApi = useApi();
  const { libs, isReady, getWritableLibs } = usePermaweb();

  const [profile, setProfile] = useState<PermaProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localSamples, setLocalSamples] = useState<LocalSample[]>([]);
  const [copiedTxId, setCopiedTxId] = useState<string | null>(null);
  const [copiedShareUrl, setCopiedShareUrl] = useState(false);
  const [copiedProfileId, setCopiedProfileId] = useState(false);
  const [audiusProfile, setAudiusProfile] = useState<AudiusUser | null>(null);
  const [audiusTracks, setAudiusTracks] = useState<AudiusTrack[]>([]);
  const [audiusAlbums, setAudiusAlbums] = useState<AudiusAlbum[]>([]);
  const [audiusPlaylists, setAudiusPlaylists] = useState<AudiusPlaylist[]>([]);
  const [audiusCatalogLoading, setAudiusCatalogLoading] = useState(false);
  const [audiusCatalogError, setAudiusCatalogError] = useState<string | null>(null);
  const [audiusCatalogExpanded, setAudiusCatalogExpanded] = useState(false);
  const [linkingAudius, setLinkingAudius] = useState(false);
  const [linkAudiusError, setLinkAudiusError] = useState<string | null>(null);
  const [linkAudiusSuccess, setLinkAudiusSuccess] = useState<string | null>(null);
  const [linkAudiusDebug, setLinkAudiusDebug] = useState<Record<string, any> | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [profileOverrideId, setProfileOverrideId] = useState<string>('');
  const [profileOverrideInput, setProfileOverrideInput] = useState<string>('');
  const [profileOptions, setProfileOptions] = useState<ProfileOption[]>([]);
  const [newSampleTxId, setNewSampleTxId] = useState('');
  const [newSampleTitle, setNewSampleTitle] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [aoTracks, setAoTracks] = useState<RegisteredTrackRecord[] | null>(null);
  const [aoBalances, setAoBalances] = useState<{ key: string; amount: number }[] | null>(null);
  const [aoDebugLoading, setAoDebugLoading] = useState(false);
  const [aoDebugError, setAoDebugError] = useState<string | null>(null);
  const [publishTrack, setPublishTrack] = useState<Track | null>(null);
  const [profileTokens, setProfileTokens] = useState<ResolvedProfileToken[]>([]);
  const tokenResolveTimerRef = useRef<number | null>(null);
  const aoTokens = useMemo(
    () => profileTokens.filter((item) => item.kind === 'ao-token'),
    [profileTokens]
  );
  const atomicAssets = useMemo(
    () => profileTokens.filter((item) => item.kind === 'atomic-asset'),
    [profileTokens]
  );

  const normalizedProfile = useMemo(() => {
    const storeRaw = (profile as any)?.store || (profile as any)?.Store || null;
    const store = libs?.mapFromProcessCase ? libs.mapFromProcessCase(storeRaw || {}) : storeRaw || {};
    const merged = {
      ...profile,
      ...store,
    } as any;
    return merged;
  }, [profile, libs]);

  const profileWalletAddress = useMemo(() => {
    const raw =
      normalizedProfile?.walletAddress ||
      normalizedProfile?.WalletAddress ||
      normalizedProfile?.owner ||
      normalizedProfile?.Owner ||
      null;
    return raw ? String(raw) : null;
  }, [normalizedProfile]);

  const connectedOverrideId = useMemo(() => {
    if (!connectedAddress) return '';
    return getStoredProfileOverrideId(connectedAddress);
  }, [connectedAddress]);

  const routeLooksLikeOwnWallet = useMemo(() => {
    if (!routeProfileRef || !connectedAddress) return false;
    return connectedAddress.toLowerCase() === routeProfileRef.toLowerCase();
  }, [connectedAddress, routeProfileRef]);

  const routeMatchesConnectedOverride = useMemo(() => {
    if (!routeProfileRef || !connectedOverrideId) return false;
    return routeProfileRef === connectedOverrideId;
  }, [connectedOverrideId, routeProfileRef]);

  const isOwn = useMemo(() => {
    if (!connectedAddress) return false;
    if (routeLooksLikeOwnWallet) return true;
    if (routeMatchesConnectedOverride) return true;
    if (profileWalletAddress && connectedAddress.toLowerCase() === profileWalletAddress.toLowerCase()) return true;
    return false;
  }, [connectedAddress, profileWalletAddress, routeLooksLikeOwnWallet, routeMatchesConnectedOverride]);

  const resolvedAddress = useMemo(() => {
    if (profileWalletAddress) return profileWalletAddress;
    if (isOwn && connectedAddress) return connectedAddress;
    return routeLooksLikeOwnWallet ? routeProfileRef || null : null;
  }, [connectedAddress, isOwn, profileWalletAddress, routeLooksLikeOwnWallet, routeProfileRef]);

  const avatarSource = useMemo(() => {
    return getProfileAvatar(normalizedProfile);
  }, [normalizedProfile]);

  const bannerSource = useMemo(() => {
    return getProfileBanner(normalizedProfile);
  }, [normalizedProfile]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const openEdit = () => {
      if (walletType === 'arweave' && isOwn && normalizedProfile?.id) {
        setEditOpen(true);
      }
    };
    window.addEventListener('streamvault:open-edit-profile', openEdit as EventListener);
    return () => {
      window.removeEventListener('streamvault:open-edit-profile', openEdit as EventListener);
    };
  }, [isOwn, normalizedProfile?.id, walletType]);

  const profileName = useMemo(
    () => getProfileDisplayName(normalizedProfile) || 'Unnamed',
    [normalizedProfile]
  );

  const profileHandle = useMemo(
    () => getProfileHandle(normalizedProfile),
    [normalizedProfile]
  );

  const profileBio = useMemo(
    () => getProfileBio(normalizedProfile),
    [normalizedProfile]
  );
  const hasIdentity = useMemo(
    () =>
      Boolean(
        avatarSource ||
        bannerSource ||
        profileHandle ||
        profileBio ||
        (profileName && profileName !== 'Unnamed')
      ),
    [avatarSource, bannerSource, profileHandle, profileBio, profileName]
  );

  const audiusProof = useMemo(() => {
    const raw = normalizedProfile?.audiusProof;
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return null;
  }, [normalizedProfile]);

  const toBase64 = (bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };

  const shareUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    const ref = normalizedProfile?.id || routeProfileRef || '';
    return `${window.location.origin}/#/profile/${ref}`;
  }, [normalizedProfile?.id, routeProfileRef]);

  const toAudiusUrl = (permalink: string) =>
    permalink.startsWith('http://') || permalink.startsWith('https://')
      ? permalink
      : `https://audius.co${permalink.startsWith('/') ? '' : '/'}${permalink}`;

  const toPlayableTrack = (track: AudiusTrack): Track => ({
    id: track.id,
    title: track.title,
    artist: track.user?.name || track.user?.handle || audiusProfile?.name || audiusUser?.name || 'Unknown artist',
    artistId: track.user?.id || String(track.user_id || ''),
    artwork: getArtworkUrl(track) || undefined,
    streamUrl: getStreamUrl(track),
    duration: track.duration,
  });

  const openAudiusLogin = () => {
    if (typeof window === 'undefined') return;
    window.open('https://audius.co/login', '_blank', 'noopener,noreferrer');
  };

  const effectiveAudiusHandle = useMemo(() => {
    const fromProfile = normalizedProfile?.audiusHandle || profile?.audiusHandle;
    if (fromProfile) return String(fromProfile);
    if (isOwn && audiusUser?.handle) return audiusUser.handle;
    return '';
  }, [normalizedProfile?.audiusHandle, profile?.audiusHandle, isOwn, audiusUser?.handle]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isReady || !libs || !routeProfileRef) return;
      const cached = PROFILE_CACHE.get(routeProfileRef);
      if (cached) {
        setProfile(cached);
        setLoading(false);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        profileLog('[profile] fetch start', { ref: routeProfileRef });
        const overrideId =
          resolvedAddress ? getStoredProfileOverrideId(resolvedAddress) : '';
        if (overrideId) {
          setProfileOverrideId(overrideId);
          setProfileOverrideInput(overrideId);
        }
        let p = overrideId ? await getProfileByIdSafe(libs, overrideId) : null;
        if (!p?.id && overrideId && resolvedAddress && typeof window !== 'undefined') {
          try {
            const raw = localStorage.getItem(getProfileSnapshotKey(resolvedAddress));
            if (raw) {
              const cached = JSON.parse(raw);
              if (cached?.id === overrideId) p = cached;
            }
          } catch {
            // ignore snapshot parse errors
          }
        }
        if (!p?.id) {
          const byId = await getProfileByIdSafe(libs, routeProfileRef);
          if (byId?.id) p = byId;
        }
        if (!p?.id && resolvedAddress) {
          p = await getSelectedOrLatestProfileByWallet(
            libs,
            resolvedAddress,
            { useOverride: true }
          );
        }
        if (
          import.meta.env.DEV &&
          profileDebug &&
          overrideId &&
          !p?.id
        ) {
          inspectProfileReadState(libs, overrideId)
            .then((diag) => console.info('[profile:read:diag]', diag))
            .catch((diagError) =>
              console.info('[profile:read:diag:error]', String((diagError as any)?.message || diagError))
            );
        }
        profileLog('[profile] data', p);
        profileLog('[profile] fetch result', { hasProfile: Boolean(p?.id) });
        if (!cancelled) {
          const keepExisting =
            !p?.id &&
            Boolean(overrideId) &&
            Boolean(profile?.id) &&
            String(profile?.id) === overrideId;
          const next = keepExisting ? profile : (p || { id: null });
          setProfile(next);
          if (next?.id) PROFILE_CACHE.set(routeProfileRef, next);
          const walletForSnapshot = inferProfileWalletAddress(next, resolvedAddress);
          if (walletForSnapshot && typeof window !== 'undefined') {
            try {
              localStorage.setItem(getProfileSnapshotKey(walletForSnapshot), JSON.stringify(next));
            } catch {
              // ignore storage failures
            }
            window.dispatchEvent(
              new CustomEvent('streamvault:profile-updated', {
                detail: { address: walletForSnapshot, profile: next },
              })
            );
          }
        }
      } catch (e: any) {
        console.error('[profile] fetch failed', e);
        if (!cancelled) setError(e?.message || 'Failed to load profile');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isReady, libs, routeProfileRef, connectedAddress]);

  useEffect(() => {
    if (!(import.meta.env.DEV && profileDebug) || !libs || typeof window === 'undefined') return;
    const target = window as any;
    target.streamvaultProfileDebug = {
      inspectProfile: (profileId: string) => inspectProfileReadState(libs, profileId),
      compareProfiles: async (firstId: string, secondId: string) => ({
        first: await inspectProfileReadState(libs, firstId),
        second: await inspectProfileReadState(libs, secondId),
      }),
    };
    return () => {
      if (target.streamvaultProfileDebug) {
        delete target.streamvaultProfileDebug;
      }
    };
  }, [libs, profileDebug]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const walletForOptions = profileWalletAddress || (isOwn ? connectedAddress : null);
      if (!libs || !walletForOptions) return;
      const cached = PROFILE_OPTIONS_CACHE.get(walletForOptions);
      if (cached) {
        setProfileOptions(cached);
        return;
      }
      try {
        profileLog('[profile] options fetch start', { address: walletForOptions });
        const options = await getProfileOptionsByWallet(libs, walletForOptions);
        if (!cancelled) {
          setProfileOptions(options);
          PROFILE_OPTIONS_CACHE.set(walletForOptions, options);
        }
      } catch (e) {
        console.error('[profile] options fetch failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libs, profileWalletAddress, isOwn, connectedAddress]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!libs) return;
      if (normalizedProfile?.id) return;
      if (!profileOptions.length) return;
      try {
        // If identity hints exist but ID is missing, resolve first indexed profile as source of truth.
        const recovered = await getProfileByIdSafe(libs, profileOptions[0].id);
        if (!cancelled && recovered?.id) setProfile(recovered);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libs, normalizedProfile?.id, profileOptions]);

  useEffect(() => {
    let cancelled = false;
    if (tokenResolveTimerRef.current != null) {
      window.clearTimeout(tokenResolveTimerRef.current);
      tokenResolveTimerRef.current = null;
    }
    tokenResolveTimerRef.current = window.setTimeout(() => {
      (async () => {
        const assets = normalizedProfile?.assets;
        const profileId = normalizedProfile?.id ? String(normalizedProfile.id) : '';
        if (!libs || !Array.isArray(assets) || assets.length === 0) {
          setProfileTokens([]);
          return;
        }
        const tokenCacheKey = `${profileId}:${JSON.stringify(assets)}`;
        const cached = PROFILE_TOKENS_CACHE.get(tokenCacheKey);
        if (cached) {
          if (!cancelled) setProfileTokens(cached);
          return;
        }
        try {
          const resolved = await resolveProfileTokens(libs, assets);
          if (!cancelled) {
            setProfileTokens(resolved);
            PROFILE_TOKENS_CACHE.set(tokenCacheKey, resolved);
          }
        } catch {
          if (!cancelled) setProfileTokens([]);
        }
      })();
    }, 150);
    return () => {
      cancelled = true;
      if (tokenResolveTimerRef.current != null) {
        window.clearTimeout(tokenResolveTimerRef.current);
        tokenResolveTimerRef.current = null;
      }
    };
  }, [libs, normalizedProfile?.assets]);

  useEffect(() => {
    let cancelled = false;
    const handle = effectiveAudiusHandle;
    if (!handle) {
      setAudiusProfile(null);
      setAudiusTracks([]);
      setAudiusAlbums([]);
      setAudiusPlaylists([]);
      setAudiusCatalogError(null);
      setAudiusCatalogLoading(false);
      return;
    }
    (async () => {
      try {
        setAudiusCatalogLoading(true);
        setAudiusCatalogError(null);
        const user = await getUserByHandle(handle);
        if (!user) {
          if (!cancelled) {
            setAudiusProfile(null);
            setAudiusTracks([]);
            setAudiusAlbums([]);
            setAudiusPlaylists([]);
          }
          return;
        }
        const userId = String(user.user_id || user.id);
        const [tracks, albums, playlists] = await Promise.all([
          getUserTracks(userId, 12),
          getUserAlbums(userId, 8),
          getUserPlaylists(userId, 8),
        ]);
        if (!cancelled) {
          setAudiusProfile(user);
          setAudiusTracks(tracks);
          setAudiusAlbums(albums);
          setAudiusPlaylists(playlists);
        }
      } catch (e: any) {
        if (!cancelled) {
          setAudiusProfile(null);
          setAudiusTracks([]);
          setAudiusAlbums([]);
          setAudiusPlaylists([]);
          setAudiusCatalogError(e?.message || 'Failed to load Audius catalog.');
        }
      } finally {
        if (!cancelled) setAudiusCatalogLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveAudiusHandle]);

  const visibleAudiusAlbums = useMemo(
    () => (audiusCatalogExpanded ? audiusAlbums : audiusAlbums.slice(0, 4)),
    [audiusCatalogExpanded, audiusAlbums]
  );
  const visibleAudiusPlaylists = useMemo(
    () => (audiusCatalogExpanded ? audiusPlaylists : audiusPlaylists.slice(0, 4)),
    [audiusCatalogExpanded, audiusPlaylists]
  );
  const visibleAudiusTracks = useMemo(
    () => (audiusCatalogExpanded ? audiusTracks : audiusTracks.slice(0, 6)),
    [audiusCatalogExpanded, audiusTracks]
  );
  const hasMoreAudiusCatalog = audiusAlbums.length > 4 || audiusPlaylists.length > 4 || audiusTracks.length > 6;

  useEffect(() => {
    if (!resolvedAddress || typeof window === 'undefined') return;
    try {
      const key = `streamvault:samples:${resolvedAddress.toLowerCase()}`;
      const stored = JSON.parse(localStorage.getItem(key) || '[]') as LocalSample[];
      setLocalSamples(stored);
    } catch {
      setLocalSamples([]);
    }
  }, [resolvedAddress]);

  const onChainSamples = useMemo(() => {
    const raw = normalizedProfile?.samples || normalizedProfile?.Samples || [];
    return Array.isArray(raw) ? (raw as LocalSample[]) : [];
  }, [normalizedProfile]);

  const handleAddSample = async () => {
    if (!libs?.addToZone || !normalizedProfile?.id || walletType !== 'arweave') return;
    const txId = newSampleTxId.trim();
    if (!txId) return;
    try {
      await libs.addToZone(
        {
          path: 'Samples[]',
          data: {
            txId,
            title: newSampleTitle.trim() || undefined,
            createdAt: new Date().toISOString(),
          },
        },
        normalizedProfile.id
      );
      setNewSampleTxId('');
      setNewSampleTitle('');
    } catch (e) {
      console.error('[profile] add sample failed', e);
    }
  };

  const handleLoadAoDebug = async () => {
    if (!resolvedAddress) return;
    setAoDebugLoading(true);
    setAoDebugError(null);
    try {
      const [tracks, balancesMap] = await Promise.all([
        searchTracksOnAO({ creator: resolvedAddress }),
        getRoyaltyPayoutPlan(),
      ]);
      setAoTracks(tracks);
      const rows: { key: string; amount: number }[] = [];
      if (balancesMap) {
        for (const [k, v] of Object.entries(balancesMap)) {
          const amount = typeof v === 'number' ? v : Number(v as any);
          if (!Number.isFinite(amount)) continue;
          // Keys are "chain:token:address"; filter for this wallet address.
          if (resolvedAddress && k.endsWith(':' + resolvedAddress)) {
            rows.push({ key: k, amount });
          }
        }
      }
      setAoBalances(rows);
    } catch (e: any) {
      setAoDebugError(e?.message || 'Failed to load AO registry / royalty state');
    } finally {
      setAoDebugLoading(false);
    }
  };

  const handleVerifyAudius = async () => {
    if (!normalizedProfile?.audiusHandle || !normalizedProfile?.id || !libs?.updateZone) return;
    if (!connectedAddress || !walletType) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const message = `StreamVault Audius verification\nHandle: ${normalizedProfile.audiusHandle}\nWallet: ${connectedAddress}\nTimestamp: ${new Date().toISOString()}`;
      let signature: string | null = null;
      if (walletType === 'ethereum' && (window as any).ethereum) {
        signature = await (window as any).ethereum.request({
          method: 'personal_sign',
          params: [message, connectedAddress],
        });
      } else if (walletType === 'solana' && (window as any).solana?.signMessage) {
        const encoded = new TextEncoder().encode(message);
        const signed = await (window as any).solana.signMessage(encoded, 'utf8');
        signature = toBase64(signed.signature);
      } else if (walletType === 'arweave' && (window as any).arweaveWallet?.signMessage) {
        const encoded = new TextEncoder().encode(message);
        const signed = await (window as any).arweaveWallet.signMessage(encoded);
        signature = typeof signed === 'string' ? signed : toBase64(signed);
      } else {
        throw new Error('Wallet does not support message signing.');
      }
      const proof = {
        handle: normalizedProfile.audiusHandle,
        walletType,
        address: connectedAddress,
        message,
        signature,
        createdAt: new Date().toISOString(),
      };
      await libs.updateZone(
        {
          AudiusHandle: normalizedProfile.audiusHandle,
          AudiusProof: JSON.stringify(proof),
        },
        normalizedProfile.id
      );
    } catch (e: any) {
      setVerifyError(e?.message || 'Verification failed');
    } finally {
      setVerifying(false);
    }
  };

  const handleProfileOverride = async (nextId?: string) => {
    if (!resolvedAddress || !libs) return;
    const id = (nextId || profileOverrideInput).trim();
    if (!id) return;
    try {
      setLoading(true);
      const p = await getProfileByIdSafe(libs, id);
      setProfile(p || { id: null });
      setProfileOverrideId(id);
      setStoredProfileOverrideId(resolvedAddress, id);
    } catch (e) {
      console.error('[profile] override failed', e);
    } finally {
      setLoading(false);
    }
  };

  const handleClearOverride = async () => {
    if (!resolvedAddress || !libs) return;
    try {
      setLoading(true);
      const p = await getLatestProfileByWallet(libs, resolvedAddress);
      setProfile(p || { id: null });
      setProfileOverrideId('');
      setProfileOverrideInput('');
      clearStoredProfileOverrideId(resolvedAddress);
    } catch (e) {
      console.error('[profile] clear override failed', e);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyTxId = async (txId: string) => {
    try {
      await navigator.clipboard.writeText(txId);
      setCopiedTxId(txId);
      window.setTimeout(() => setCopiedTxId(null), 1500);
    } catch (e) {
      console.warn('[profile] Clipboard copy failed', e);
    }
  };

  const handleCopyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedShareUrl(true);
      window.setTimeout(() => setCopiedShareUrl(false), 1400);
    } catch {
      // ignore
    }
  };

  const handleCopyProfileId = async () => {
    if (!normalizedProfile?.id) return;
    try {
      await navigator.clipboard.writeText(String(normalizedProfile.id));
      setCopiedProfileId(true);
      window.setTimeout(() => setCopiedProfileId(false), 1400);
    } catch {
      // ignore
    }
  };

  const handleLinkAudiusToProfile = async () => {
    if (!isOwn || !connectedAddress || walletType !== 'arweave' || !audiusUser || !libs) return;
    setLinkingAudius(true);
    setLinkAudiusError(null);
    setLinkAudiusSuccess(null);
    setLinkAudiusDebug(null);
    try {
      const injectedWallet = typeof window !== 'undefined' ? (window as any).arweaveWallet : null;
      const signerWallet = injectedWallet || arweaveApi || null;
      if (!signerWallet) throw new Error('Arweave signer unavailable.');

      const permissionsBefore = await signerWallet.getPermissions?.().catch(() => null);
      if (signerWallet?.connect) {
        await signerWallet.connect([
          'ACCESS_ADDRESS',
          'ACCESS_PUBLIC_KEY',
          'SIGN_TRANSACTION',
          'SIGNATURE',
          'DISPATCH',
        ]);
      }
      const permissionsAfter = await signerWallet.getPermissions?.().catch(() => null);

      const signerAddress = await signerWallet.getActiveAddress?.().catch(() => null);
      const writableLibs = await getWritableLibs();
      if (!writableLibs?.updateZone) {
        throw new Error('Writable permaweb client unavailable. Reconnect Wander and retry.');
      }
      const profileRecord =
        normalizedProfile?.id
          ? { id: normalizedProfile.id }
          : await getSelectedOrLatestProfileByWallet(libs, connectedAddress);
      if (!profileRecord?.id) {
        throw new Error('Create an Arweave profile first, then link your Audius identity.');
      }
      const resolvedHandle =
        String(profileHandle || normalizedProfile?.username || '').trim() ||
        String(connectedAddress || '').slice(0, 12);
      const resolvedName =
        String(
          (profileName !== 'Unnamed' ? profileName : '') ||
          normalizedProfile?.displayName ||
          normalizedProfile?.name ||
          resolvedHandle
        ).trim();
      const resolvedBio = String(profileBio || normalizedProfile?.description || '').trim();
      const zonePayload = {
        Name: resolvedName,
        Handle: resolvedHandle,
        Bio: resolvedBio,
        AudiusHandle: String(audiusUser.handle || '').trim(),
      };
      await writableLibs.updateZone(zonePayload, profileRecord.id);

      setProfile((prev) => (prev ? { ...prev, audiusHandle: audiusUser.handle } : prev));
      window.dispatchEvent(new CustomEvent('streamvault:profile-updated'));
      setLinkAudiusDebug({
        status: 'success',
        usedPath: 'fresh-writable-updateZone',
        signerSource: injectedWallet ? 'injected' : 'wallet-kit-api',
        signerAddress,
        permissionsBefore,
        permissionsAfter,
        connectedAddress,
        profileId: profileRecord.id,
        payload: zonePayload,
      });
      setLinkAudiusSuccess('Audius identity linked to profile.');
    } catch (e: any) {
      const msg = String(e?.message || 'Failed to link Audius profile.');
      setLinkAudiusDebug({
        status: 'error',
        message: msg,
        signerSource:
          (typeof window !== 'undefined' && (window as any).arweaveWallet)
            ? 'injected'
            : 'wallet-kit-api',
        stack: e?.stack ? String(e.stack).slice(0, 1200) : '',
      });
      setLinkAudiusError(`Failed to link Audius profile. ${msg.replace(/^Error:\s*/g, '')}`);
    } finally {
      setLinkingAudius(false);
    }
  };

  const handleCreateProfile = async (form: {
    username: string;
    displayName: string;
    description: string;
    thumbnail?: File | null;
    banner?: File | null;
    thumbnailValue?: string | null;
    bannerValue?: string | null;
    removeThumbnail?: boolean;
    removeBanner?: boolean;
  }) => {
    if (!libs?.createProfile || !connectedAddress) return;
    setCreating(true);
    setError(null);
    try {
      profileLog('[profile] create start', { address: connectedAddress });
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
        thumbnail: args.thumbnail || null,
        banner: args.banner || null,
      });
      const { profileId, thumbnailId, bannerId } = created;
      const immediateThumbnail = args.thumbnail || thumbnailId || null;
      const immediateBanner = args.banner || bannerId || null;
      profileLog('[profile] create success', { profileId });
      setStoredProfileOverrideId(connectedAddress, profileId);
      setProfile({
        id: profileId,
        walletAddress: connectedAddress,
        username: args.username,
        displayName: args.displayName,
        description: args.description,
        thumbnail: immediateThumbnail,
        banner: immediateBanner,
        thumbnailTxId: thumbnailId,
        bannerTxId: bannerId,
      });
      if (typeof window !== 'undefined') {
        const next = {
          id: profileId,
          walletAddress: connectedAddress,
          username: args.username,
          displayName: args.displayName,
          description: args.description,
          thumbnail: immediateThumbnail,
          banner: immediateBanner,
          thumbnailTxId: thumbnailId,
          bannerTxId: bannerId,
        };
        try {
          localStorage.setItem(getProfileSnapshotKey(connectedAddress), JSON.stringify(next));
        } catch {
          // ignore storage failures
        }
        window.dispatchEvent(
          new CustomEvent('streamvault:profile-updated', {
            detail: { address: connectedAddress, profile: next },
          })
        );
      }
      setCreateOpen(false);
      navigate(`/profile/${profileId}`, { replace: true });

      if (profileId && localSamples.length > 0 && writableLibs.addToZone) {
        setSyncing(true);
        try {
          for (const sample of localSamples) {
            await writableLibs.addToZone(
              {
                path: 'Samples[]',
                data: sample,
              },
              profileId
            );
          }
          profileLog('[profile] local samples synced', { count: localSamples.length });
        } catch (e) {
          console.warn('[profile] Failed to sync samples', e);
        } finally {
          setSyncing(false);
        }
      }

      // Best-effort refresh (indexing may lag)
      try {
        const fresh = await getSelectedOrLatestProfileByWallet(libs, connectedAddress, { useOverride: true });
        if (fresh?.id) setProfile(fresh);
      } catch {
        // ignore - eventual consistency
      }
    } catch (e: any) {
      console.error('[profile] create failed', e);
      const msg = String(e?.message || '');
      const isLocalhost =
        typeof window !== 'undefined' &&
        /^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);
      if (msg.includes('not allowed on this SU') || (msg.includes('Process') && msg.includes('not allowed'))) {
        setError('Profile creation hit an AO network mismatch. The app is trying to create a mainnet profile through a non-mainnet scheduler unit.');
      } else if (
        isLocalhost &&
        (msg.includes('Error spawning process') ||
          msg.includes('HTTP request failed') ||
          msg.includes('Gateway Timeout') ||
          msg.includes('Failed to fetch'))
      ) {
        setError('Mainnet profile creation from localhost is being blocked or timing out at the HyperBEAM transport layer. Test this same flow from a preview or production deployment instead of localhost.');
      } else if (msg.includes('Error spawning process')) {
        setError('Mainnet profile spawning failed. This usually means the AO mainnet process constants or authority tags are mismatched.');
      } else {
        setError(msg || 'Profile creation failed');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleEditProfile = async (form: {
    username: string;
    displayName: string;
    description: string;
    thumbnail?: File | null;
    banner?: File | null;
    thumbnailValue?: string | null;
    bannerValue?: string | null;
    removeThumbnail?: boolean;
    removeBanner?: boolean;
  }) => {
    if (!libs?.updateProfile || !normalizedProfile?.id || walletType !== 'arweave') return;
    setCreating(true);
    setError(null);
    try {
      const writableLibs = await getWritableLibs();
      if (!writableLibs) {
        throw new Error('Arweave writable profile client is not ready.');
      }
      const args: any = {
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        description: form.description.trim(),
      };
      if (form.thumbnail) {
        args.thumbnail = await fileToDataURL(form.thumbnail);
      } else if (!form.removeThumbnail && form.thumbnailValue) {
        args.thumbnail = form.thumbnailValue;
      }
      if (form.banner) {
        args.banner = await fileToDataURL(form.banner);
      } else if (!form.removeBanner && form.bannerValue) {
        args.banner = form.bannerValue;
      }

      await writableLibs.updateProfile(args, normalizedProfile.id);
      const optimistic = {
        ...normalizedProfile,
        username: form.username.trim(),
        displayName: form.displayName.trim(),
        description: form.description.trim(),
        thumbnail: args.thumbnail || normalizedProfile?.thumbnail || normalizedProfile?.Thumbnail || null,
        banner: args.banner || normalizedProfile?.banner || normalizedProfile?.Banner || null,
        thumbnailTxId: form.thumbnail
          ? null
          : (normalizedProfile as any)?.thumbnailTxId || normalizedProfile?.thumbnail || normalizedProfile?.Thumbnail || null,
        bannerTxId: form.banner
          ? null
          : (normalizedProfile as any)?.bannerTxId || normalizedProfile?.banner || normalizedProfile?.Banner || null,
      };
      setProfile(optimistic);
      const fresh =
        (await writableLibs.getProfileById?.(normalizedProfile.id)) ||
        (resolvedAddress ? await getSelectedOrLatestProfileByWallet(writableLibs, resolvedAddress, { useOverride: true }) : null);
      if (fresh) setProfile(fresh);
      const nextProfile = fresh || optimistic;
      if (nextProfile && connectedAddress && typeof window !== 'undefined') {
        try {
          localStorage.setItem(getProfileSnapshotKey(connectedAddress), JSON.stringify(nextProfile));
        } catch {
          // ignore storage failures
        }
        window.dispatchEvent(
          new CustomEvent('streamvault:profile-updated', {
            detail: { address: connectedAddress, profile: nextProfile },
          })
        );
      }
      setEditOpen(false);
    } catch (e: any) {
      setError(e?.message || 'Profile update failed');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className={styles.page}>
      {bannerSource && (
        <div className={styles.bannerWrap}>
          <img className={styles.bannerImg} src={bannerSource} alt="" />
        </div>
      )}
      <header className={styles.header + ' glass'}>
        {avatarSource ? (
          <img className={styles.avatarImg} src={avatarSource} alt="" />
        ) : (
          <div className={styles.avatarPlaceholder} />
        )}
        <div>
          <h1 className={styles.title}>
            {hasIdentity ? profileName : isOwn ? 'Your profile' : 'Creator profile'}
          </h1>
          {profileHandle && <p className={styles.subtext}>@{profileHandle}</p>}
          {profileBio && <p className={styles.subtext}>{profileBio}</p>}
          <p className={styles.address}>{resolvedAddress?.slice(0, 8)}…{resolvedAddress?.slice(-8)}</p>
          {walletType && <span className={styles.walletType}>{walletType}</span>}
        </div>
      </header>
      {(audiusProfile || (isOwn && audiusUser)) && (
        <section className={styles.section}>
          <div className={styles.profileCard}>
            <div>
              <p className={styles.profileName}>{audiusProfile?.name || audiusUser?.name || 'Audius account'}</p>
              <p className={styles.subtext}>Audius · @{audiusProfile?.handle || audiusUser?.handle}</p>
            </div>
            <div className={styles.profileMeta}>
              <span className={styles.mono}>{audiusProfile?.track_count ?? audiusTracks.length} tracks</span>
              {typeof audiusProfile?.playlist_count === 'number' && (
                <span className={styles.monoValue}>{audiusProfile?.playlist_count} playlists</span>
              )}
              {isOwn && audiusUser && (
                <div className={styles.sampleLinks}>
                  <button type="button" className={styles.copyBtn} onClick={handleLinkAudiusToProfile} disabled={linkingAudius}>
                    {linkingAudius ? 'Linking…' : 'Link Audius to profile'}
                  </button>
                  <button type="button" className={styles.copyBtn} onClick={logout}>
                    Disconnect Audius
                  </button>
                </div>
              )}
            </div>
          </div>
          {linkAudiusError && <p className={styles.error} style={{ marginTop: '10px' }}>{linkAudiusError}</p>}
          {linkAudiusSuccess && <p className={styles.subtext} style={{ marginTop: '10px' }}>{linkAudiusSuccess}</p>}
          {linkAudiusDebug && (
            <pre className={styles.subtext} style={{ whiteSpace: 'pre-wrap', marginTop: '10px' }}>
              {JSON.stringify(linkAudiusDebug, null, 2)}
            </pre>
          )}
          <div className={styles.audiusMiniWrap}>
            <div className={styles.audiusMiniHeader}>
              <h3 className={styles.sectionTitle}>Audius catalog</h3>
              <div className={styles.audiusMiniActions}>
                {hasMoreAudiusCatalog && (
                  <button
                    type="button"
                    className={styles.copyBtn}
                    onClick={() => setAudiusCatalogExpanded((v) => !v)}
                  >
                    {audiusCatalogExpanded ? 'Show less' : 'Show more'}
                  </button>
                )}
                <a className={styles.link} href="#/vault/library">Open full view</a>
              </div>
            </div>
            {audiusCatalogError && <p className={styles.error}>{audiusCatalogError}</p>}
            {audiusCatalogLoading ? (
              <p className={styles.subtext}>Loading tracks and albums…</p>
            ) : (
              <>
                {visibleAudiusAlbums.length > 0 && (
                  <div>
                    <p className={styles.subtext}>Albums</p>
                    <div className={styles.audiusMiniChips}>
                      {visibleAudiusAlbums.map((album) => (
                        <a
                          key={album.id}
                          className={styles.audiusMiniChip}
                          href={toAudiusUrl(album.permalink)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {album.playlist_name} ({album.track_count})
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {visibleAudiusPlaylists.length > 0 && (
                  <div>
                    <p className={styles.subtext}>Playlists</p>
                    <div className={styles.audiusMiniChips}>
                      {visibleAudiusPlaylists.map((playlist) => (
                        <a
                          key={playlist.id}
                          className={styles.audiusMiniChip}
                          href={toAudiusUrl(playlist.permalink)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {playlist.playlist_name} ({playlist.track_count})
                        </a>
                      ))}
                    </div>
                  </div>
                )}
                {visibleAudiusTracks.length > 0 ? (
                  <div className={styles.audiusMiniList}>
                    {visibleAudiusTracks.map((track) => (
                      <div key={track.id} className={styles.audiusMiniItem}>
                        {getArtworkUrl(track) ? (
                          <img className={styles.audiusMiniArt} src={getArtworkUrl(track) || ''} alt="" />
                        ) : (
                          <div className={styles.audiusMiniArtPlaceholder} />
                        )}
                        <div className={styles.audiusMiniMeta}>
                          <span className={styles.mono}>{track.title}</span>
                          <span className={styles.subtext}>@{track.user.handle}</span>
                        </div>
                        <button
                          type="button"
                          className={styles.copyBtn}
                          onClick={() => {
                            const playable = toPlayableTrack(track);
                            const isCurrent = currentTrack?.id === playable.id;
                            if (isCurrent && isPlaying) pause();
                            else play(playable);
                          }}
                        >
                          {currentTrack?.id === track.id && isPlaying ? 'Pause' : 'Play'}
                        </button>
                        {isOwn && (
                          <button
                            type="button"
                            className={styles.copyBtn}
                            onClick={() => setPublishTrack(toPlayableTrack(track))}
                          >
                            Publish
                          </button>
                        )}
                        <a
                          className={styles.link}
                          href={toAudiusUrl(track.permalink)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open
                        </a>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.subtext}>No Audius tracks found for this handle yet.</p>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {isOwn && !audiusUser && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Audius account</h2>
          </div>
          <p className={styles.subtext}>
            Connect Audius to load your tracks/albums here and publish your own catalog to Arweave.
          </p>
          <p className={styles.subtext} style={{ marginTop: '8px' }}>
            If your Audius account uses email/social login, open Audius first and sign in there before connecting.
          </p>
          {apiKeyConfigured ? (
            <div className={styles.sampleLinks} style={{ marginTop: '10px' }}>
              <button
                type="button"
                className={styles.copyBtn}
                onClick={openAudiusLogin}
              >
                Open Audius first
              </button>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={login}
                disabled={isLoggingIn}
              >
                {isLoggingIn ? 'Connecting…' : 'Connect Audius'}
              </button>
            </div>
          ) : (
            <p className={styles.error}>Audius login is not configured for this app.</p>
          )}
          {audiusAuthError && <p className={styles.error}>{audiusAuthError}</p>}
        </section>
      )}
      <section className={styles.section}>
        <p className={styles.text}>
          Share your profile: <strong>{shareUrl}</strong>
        </p>
        <div className={styles.sampleLinks} style={{ marginTop: '8px' }}>
          <button type="button" className={styles.copyBtn} onClick={handleCopyShareUrl}>
            {copiedShareUrl ? 'Copied share URL' : 'Copy share URL'}
          </button>
          {normalizedProfile?.id && (
            <button type="button" className={styles.copyBtn} onClick={handleCopyProfileId}>
              {copiedProfileId ? 'Copied profile ID' : 'Copy profile ID'}
            </button>
          )}
        </div>
        <p className={styles.subtext}>
          Permanently published tracks and atomic assets you create will appear here. Connect with the same wallet you use as the verified artist to publish.
        </p>
      </section>

      <section className={styles.section + ' ' + styles.sectionTight}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Generate cover art with Art Engine</h2>
        </div>
        <p className={styles.subtext}>
          Use the Art Engine in this repo to create unique layered artwork. Generate cover art in the browser (Creator tools), then use it when publishing to Arweave (Full — Cover image).
        </p>
        <a href="#/creator-tools" className={styles.link}>
          Creator tools &amp; full steps →
        </a>
      </section>

      <section className={styles.section + ' ' + styles.sectionTight}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Permaweb profile</h2>
        </div>

        {walletType !== 'arweave' ? (
          <p className={styles.subtext}>Connect <strong>Wander</strong> to create and manage your permaweb profile.</p>
        ) : loading ? (
          <LogoSpinner />
        ) : error ? (
          <p className={styles.error}>{error}</p>
        ) : normalizedProfile?.id || hasIdentity ? (
          <div className={styles.profileCard}>
            <div>
              <p className={styles.profileName}>{profileName}</p>
              {profileHandle && <p className={styles.subtext}>@{profileHandle}</p>}
              <p className={styles.subtext}>{profileBio || 'No description yet.'}</p>
            </div>
            <div className={styles.profileMeta}>
              {walletType === 'arweave' && isOwn && (
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={() => setEditOpen(true)}
                >
                  Edit profile
                </button>
              )}
              <span className={styles.mono}>Profile ID</span>
              <span className={styles.monoValue}>
                {normalizedProfile?.id ? `${String(normalizedProfile.id).slice(0, 12)}…` : 'Resolving…'}
              </span>
            </div>
          </div>
        ) : (
          <>
            <p className={styles.subtext}>
              No permaweb profile found for this wallet yet. Create one to make your identity permanent and creator-first.
            </p>
            {walletType === 'arweave' && isOwn && (
              <div className={styles.emptyProfileActions}>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={() => setCreateOpen(true)}
                >
                  Create profile
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {normalizedProfile?.id && aoTokens.length > 0 && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>AO tokens</h2>
          </div>
          <div className={styles.sampleList}>
            {aoTokens.map((token) => (
              <div key={`${token.id}:${token.rawBalance}`} className={styles.sampleItem}>
                <div>
                  <span className={styles.mono}>{token.ticker || token.name}</span>
                  <span className={styles.monoValue}>{token.name}</span>
                  <span className={styles.monoValue}>{token.id.slice(0, 12)}…</span>
                  <span className={styles.monoValue}>
                    debug: kind={token.kind} source={token.debug.infoSource}
                    {token.debug.assetType ? ` assetType=${token.debug.assetType}` : ''}
                    {' '}denom={token.denomination} raw={token.rawBalance}
                  </span>
                </div>
                <div className={styles.sampleLinks}>
                  {token.imageUrl && <img src={token.imageUrl} alt="" className={styles.tokenImg} />}
                  <span className={styles.subtext}>Balance: {token.displayBalance}</span>
                  {token.id && (
                    <button
                      type="button"
                      className={styles.copyBtn}
                      onClick={() => handleCopyTxId(token.id)}
                    >
                      {copiedTxId === token.id ? 'Copied' : 'Copy id'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {normalizedProfile?.id && atomicAssets.length > 0 && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Digital assets</h2>
          </div>
          <p className={styles.subtext}>
            Atomic assets found in profile holdings.
          </p>
          <div className={styles.sampleList}>
            {atomicAssets.map((asset) => (
              <div key={`${asset.id}:${asset.rawBalance}`} className={styles.sampleItem}>
                <div>
                  <span className={styles.mono}>{asset.name}</span>
                  {asset.ticker && <span className={styles.monoValue}>{asset.ticker}</span>}
                  <span className={styles.monoValue}>{asset.id.slice(0, 12)}…</span>
                  <span className={styles.monoValue}>
                    debug: kind={asset.kind} source={asset.debug.infoSource}
                    {asset.debug.assetType ? ` assetType=${asset.debug.assetType}` : ''}
                    {' '}qty={asset.rawBalance}
                  </span>
                </div>
                <div className={styles.sampleLinks}>
                  {asset.imageUrl && <img src={asset.imageUrl} alt="" className={styles.tokenImg} />}
                  {asset.id && (
                    <button
                      type="button"
                      className={styles.copyBtn}
                      onClick={() => handleCopyTxId(asset.id)}
                    >
                      {copiedTxId === asset.id ? 'Copied' : 'Copy id'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {normalizedProfile?.audiusHandle && normalizedProfile?.id && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Audius verification</h2>
          </div>
          <p className={styles.subtext}>
            Link your Audius handle with a wallet signature for community trust.
          </p>
          {audiusProof && (
            <p className={styles.subtext}>Verified with {audiusProof.walletType} wallet.</p>
          )}
          {verifyError && <p className={styles.error}>{verifyError}</p>}
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={!walletType || verifying}
            onClick={handleVerifyAudius}
          >
            {verifying ? 'Verifying…' : audiusProof ? 'Re-verify' : 'Verify Audius handle'}
          </button>
        </section>
      )}

      {false && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Profile source</h2>
          </div>
          <p className={styles.subtext}>
            {profileOverrideId
              ? `Using profile id: ${profileOverrideId}`
              : 'Using latest profile returned by the SDK for this wallet.'}
          </p>
          {profileOptions.length > 0 && (
            <div className={styles.profileList}>
              {profileOptions.map((option) => (
                <div key={option.id} className={styles.profileListItem}>
                  <div>
                    <span className={styles.mono}>Profile ID</span>
                    <span className={styles.monoValue}>{option.id.slice(0, 12)}…</span>
                    {option.timestamp && (
                      <span className={styles.profileDate}>
                        {new Date(option.timestamp).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    onClick={() => {
                      setProfileOverrideInput(option.id);
                      handleProfileOverride(option.id);
                    }}
                    disabled={profileOverrideId === option.id || (!profileOverrideId && profile?.id === option.id)}
                  >
                    {profileOverrideId === option.id || (!profileOverrideId && profile?.id === option.id) ? 'Active' : 'Use'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {profileOptions.length === 0 && (
            <p className={styles.subtext}>
              No profile list returned yet. Check console for options fetch logs.
            </p>
          )}
          <div className={styles.overrideRow}>
            <input
              className={styles.input}
              value={profileOverrideInput}
              onChange={(e) => setProfileOverrideInput(e.target.value)}
              placeholder="Profile ID (optional)"
            />
            <button type="button" className={styles.primaryBtn} onClick={() => handleProfileOverride()}>
              Load by ID
            </button>
            <button type="button" className={styles.secondaryBtn} onClick={handleClearOverride}>
              Clear
            </button>
          </div>
        </section>
      )}

      {onChainSamples.length > 0 && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Sound bites</h2>
          </div>
          <p className={styles.subtext}>
            Sound bites attached to your permaweb profile. Use them in the{' '}
            <a href="#/creator-tools" className={styles.link}>Beat generator</a> (Creator tools) to build a new track.
          </p>
          <div className={styles.sampleList}>
            {onChainSamples.map((sample) => (
              <div key={sample.txId} className={styles.sampleItem}>
                <div>
                  <span className={styles.mono}>{sample.title}</span>
                  <span className={styles.monoValue}>{sample.txId.slice(0, 12)}…</span>
                </div>
                <div className={styles.sampleLinks}>
                  <a
                    className={styles.link}
                    href={`https://arweave.net/${sample.txId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    arweave.net
                  </a>
                  {sample.arioUrl && (
                    <a className={styles.link} href={sample.arioUrl} target="_blank" rel="noopener noreferrer">
                      ar.io
                    </a>
                  )}
                  <button
                    type="button"
                    className={styles.copyBtn}
                    onClick={() => handleCopyTxId(sample.txId)}
                  >
                    {copiedTxId === sample.txId ? 'Copied' : 'Copy tx id'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {normalizedProfile?.id && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Add existing upload</h2>
          </div>
          <p className={styles.subtext}>
            Paste a transaction id to attach a past upload to your profile.
          </p>
          <div className={styles.overrideRow}>
            <input
              className={styles.input}
              value={newSampleTxId}
              onChange={(e) => setNewSampleTxId(e.target.value)}
              placeholder="Arweave tx id"
            />
            <input
              className={styles.input}
              value={newSampleTitle}
              onChange={(e) => setNewSampleTitle(e.target.value)}
              placeholder="Title (optional)"
            />
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={handleAddSample}
              disabled={walletType !== 'arweave' || !newSampleTxId.trim()}
              title={walletType !== 'arweave' ? 'Connect Wander (Arweave) to attach uploads' : undefined}
            >
              Add to profile
            </button>
          </div>
        </section>
      )}

      {onChainSamples.length === 0 && localSamples.length > 0 && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Local uploads</h2>
          </div>
          <p className={styles.subtext}>
            Recent sound bites saved on this device. Create a permaweb profile to store them on-chain.
          </p>
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={walletType !== 'arweave' || syncing}
            onClick={() => setCreateOpen(true)}
            title={walletType !== 'arweave' ? 'Connect Wander (Arweave) to sync' : undefined}
          >
            {walletType !== 'arweave' ? 'Connect Wander' : syncing ? 'Syncing…' : 'Sync to Arweave'}
          </button>
          <div className={styles.sampleList}>
            {localSamples.map((sample) => (
              <div key={sample.txId} className={styles.sampleItem}>
                <div>
                  <span className={styles.mono}>{sample.title}</span>
                  <span className={styles.monoValue}>{sample.txId.slice(0, 12)}…</span>
                </div>
                <div className={styles.sampleLinks}>
                  <a
                    className={styles.link}
                    href={`https://arweave.net/${sample.txId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    arweave.net
                  </a>
                  {sample.arioUrl && (
                    <a className={styles.link} href={sample.arioUrl} target="_blank" rel="noopener noreferrer">
                      ar.io
                    </a>
                  )}
                  <button
                    type="button"
                    className={styles.copyBtn}
                    onClick={() => handleCopyTxId(sample.txId)}
                  >
                    {copiedTxId === sample.txId ? 'Copied' : 'Copy tx id'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {isOwn && resolvedAddress && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>AO debug: registry &amp; royalties</h2>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={handleLoadAoDebug}
              disabled={aoDebugLoading}
            >
              {aoDebugLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          <p className={styles.subtext}>
            For testing: this reads from your AO MusicRegistry and RoyaltyEngine processes using your wallet
            address. Use it to verify that publishes are registering correctly and that balances accrue when you
            hook up paid usage flows.
          </p>
          {aoDebugError && <p className={styles.error}>{aoDebugError}</p>}
          {aoDebugLoading && <LogoSpinner />}

          {aoTracks && aoTracks.length > 0 && (
            <div className={styles.sampleList}>
              {aoTracks.map((track) => (
                <div key={track.assetId} className={styles.sampleItem}>
                  <div>
                    <span className={styles.mono}>Asset</span>
                    <span className={styles.monoValue}>{track.assetId.slice(0, 12)}…</span>
                    {track.createdAt && (
                      <span className={styles.profileDate}>
                        {new Date(track.createdAt * 1000).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <div className={styles.sampleLinks}>
                    <span className={styles.subtext}>
                      License: <strong>{track.udl?.licenseId || 'udl://music/1.0'}</strong>{' '}
                      · AI: <strong>{track.udl?.aiUse || 'n/a'}</strong>
                    </span>
                    {track.audioTxId && (
                      <a
                        className={styles.link}
                        href={`https://arweave.net/${track.audioTxId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        audio tx
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {aoTracks && aoTracks.length === 0 && !aoDebugLoading && (
            <p className={styles.subtext}>
              No AO registry entries found yet for this wallet. Publish a full asset with Wander connected and try
              again.
            </p>
          )}

          {aoBalances && aoBalances.length > 0 && (
            <div className={styles.sampleList} style={{ marginTop: '16px' }}>
              {aoBalances.map((row) => {
                const [chain, token, addr] = row.key.split(':');
                return (
                  <div key={row.key} className={styles.sampleItem}>
                    <div>
                      <span className={styles.mono}>{chain}/{token}</span>
                      <span className={styles.monoValue}>{addr.slice(0, 10)}…</span>
                    </div>
                    <div className={styles.sampleLinks}>
                      <span className={styles.subtext}>Accrued: {row.amount}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {aoBalances && aoBalances.length === 0 && !aoDebugLoading && (
            <p className={styles.subtext}>
              No royalty balances recorded for this wallet in the current RoyaltyEngine process.
            </p>
          )}
        </section>
      )}

      {createOpen && (
        <CreateProfileModal
          creating={creating}
          onClose={() => setCreateOpen(false)}
          onCreate={handleCreateProfile}
        />
      )}

      {editOpen && (
        <CreateProfileModal
          mode="edit"
          creating={creating}
          onClose={() => setEditOpen(false)}
          initialUsername={profileHandle || normalizedProfile?.username || ''}
          initialDisplayName={profileName !== 'Unnamed' ? profileName : ''}
          initialDescription={profileBio || normalizedProfile?.description || ''}
          initialAvatarUrl={avatarSource}
          initialBannerUrl={bannerSource}
          initialThumbnailValue={(normalizedProfile as any)?.thumbnailTxId || normalizedProfile?.thumbnail || normalizedProfile?.Thumbnail || null}
          initialBannerValue={(normalizedProfile as any)?.bannerTxId || normalizedProfile?.banner || normalizedProfile?.Banner || null}
          onCreate={handleEditProfile}
        />
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
