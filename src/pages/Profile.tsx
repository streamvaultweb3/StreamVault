import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { usePermaweb } from '../context/PermawebContext';
import { useAudiusAuth } from '../context/AudiusAuthContext';
import type { Track } from '../context/PlayerContext';
import { TrackCard } from '../components/TrackCard';
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
import { useArweaveMediaSources } from '../hooks/useArweaveMediaSources';
import { UploadedTrackMeta } from '../components/UploadedTrackMeta';
import { type RegisteredTrackRecord, searchTracksOnAO } from '../lib/aoMusicRegistry';
import { getRoyaltyPayoutPlan } from '../lib/aoRoyaltyEngine';
import {
  clearStoredProfileOverrideId,
  collectProfileAssetRefs,
  getProfileBio,
  getProfileDisplayName,
  getProfileHandle,
  getLatestProfileByWallet,
  getProfileOptionsByWallet,
  getProfileByIdSafe,
  getSelectedOrLatestProfileByWallet,
  getProfileReadLibs,
  getStoredProfileOverrideId,
  inferProfileWalletAddress,
  invalidateLatestProfileCache,
  isLikelyArweaveAddressRef,
  profileOwnedByWallet,
  resolveProfileMediaUrls,
  resolveProfileScheduler,
  setStoredProfileOverrideId,
  shouldCanonicalizeProfileRoute,
} from '../lib/permaProfile';
import { resolveProfileZoneWriteNodeUrls } from '../lib/aoNode';
import {
  applyProfileZoneExtras,
  buildPermawebProfileArgs,
  buildPermawebProfileArgsWithTimeout,
  connectArweaveSignerForProfile,
  createPermawebProfile,
  extractRawProfileMediaRef,
  getWritableProfileLibs,
  refreshProfileAfterWrite,
  resolveArweaveSigner,
  writeAndConfirmProfileUpdate,
} from '../lib/profileWrite';
import { resolveProfileTokens, type ResolvedProfileToken } from '../lib/profileTokens';
import { PublishModal } from '../components/PublishModal';
import { arweaveTxDataUrl, turboTxDataUrl } from '../lib/arweaveDataGateway';
import { queryPermanentUploadsByOwner, queryAtomicAssetsByCreator, type AtomicAssetSummary } from '../lib/arweaveDiscovery';
import { arweaveArtistPath, looksLikeWalletAddress } from '../lib/arweaveArtist';
import { readUploadLedger } from '../lib/uploadLedger';
import {
  matchUploadedTrackToAudiusTrack,
  mergeAudiusTrackWithPersistedUpload,
  normalizeUploadedTrackRecord,
  uploadedTrackToPlayerTrack,
  uploadedTrackShareUrl,
  type UploadedTrackRecord,
} from '../lib/uploadedTracks';
import { useApi } from '@arweave-wallet-kit/react';
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
  assets?: any[];
};

type LocalSample = UploadedTrackRecord;

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

function clearProfileSessionCaches() {
  PROFILE_CACHE.clear();
  PROFILE_OPTIONS_CACHE.clear();
  PROFILE_TOKENS_CACHE.clear();
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function resolveProfileImages(raw: unknown): string[] {
  return resolveProfileMediaUrls(raw);
}

function resolveArtworkUrl(raw: unknown): string | undefined {
  return resolveProfileImages(raw)[0] || undefined;
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14">
      <path
        fill="currentColor"
        d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"
      />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 16V4m0 0 4 4m-4-4-4 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 20h14" strokeLinecap="round" />
    </svg>
  );
}

function uploadedSampleToTrack(sample: LocalSample): Track {
  return {
    id: sample.txId,
    title: sample.title,
    artist: sample.artist || 'Unknown artist',
    artistId: sample.walletAddress || sample.txId,
    artwork: sample.artworkTxId ? resolveArtworkUrl(sample.artworkTxId) : sample.artworkUrl,
    streamUrl: uploadedTrackShareUrl(sample),
    isPermanent: true,
    permaTxId: sample.txId,
    assetId: sample.assetId,
  };
}

export function Profile() {
  const profileDebug =
    import.meta.env.DEV &&
    (String(import.meta.env.VITE_DEBUG_PROFILE || '') === '1' ||
      String(import.meta.env.VITE_DEBUG_PERMAWEB || '') === '1');
  const profileLog = (...args: any[]) => {
    if (profileDebug) console.info(...args);
  };
  const { address: routeProfileRef } = useParams<{ address: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { address: connectedAddress, walletType } = useWallet();
  const { audiusUser, login, logout, apiKeyConfigured, isLoggingIn, authError: audiusAuthError } = useAudiusAuth();
  const arweaveApi = useApi();
  const { libs, isReady, getWritableLibs } = usePermaweb();

  const [profile, setProfile] = useState<PermaProfile | null>(null);
  const profileRef = useRef<PermaProfile | null>(null);
  profileRef.current = profile;
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localSamples, setLocalSamples] = useState<LocalSample[]>([]);
  const [chainProfileUploads, setChainProfileUploads] = useState<UploadedTrackRecord[]>([]);
  const [chainAtomicAssets, setChainAtomicAssets] = useState<AtomicAssetSummary[]>([]);
  const [copiedTxId, setCopiedTxId] = useState<string | null>(null);
  const [copiedShareUrl, setCopiedShareUrl] = useState(false);
  const [copiedProfileId, setCopiedProfileId] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
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
  /** Tracks registered on AO for this wallet (any connected address merged when viewing own profile). */
  const [aoPublishedTracks, setAoPublishedTracks] = useState<RegisteredTrackRecord[]>([]);
  const [profileTokens, setProfileTokens] = useState<ResolvedProfileToken[]>([]);
  const tokenResolveTimerRef = useRef<number | null>(null);
  const profileSaveInFlightRef = useRef(false);
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

  const cachedOwnProfileId = useMemo(() => {
    if (!connectedAddress || typeof window === 'undefined') return '';
    return localStorage.getItem(`streamvault:lastProfileId:${connectedAddress.toLowerCase()}`) || '';
  }, [connectedAddress]);

  const isWalletRoute = useMemo(() => {
    if (!routeProfileRef || !connectedAddress) return false;
    return routeProfileRef.toLowerCase() === connectedAddress.toLowerCase();
  }, [routeProfileRef, connectedAddress]);

  const prevConnectedAddressRef = useRef<string | null>(null);

  useEffect(() => {
    const connected = connectedAddress?.toLowerCase() || null;
    const prev = prevConnectedAddressRef.current;

    if (prev && connected && prev !== connected) {
      clearProfileSessionCaches();
      invalidateLatestProfileCache(prev);
      invalidateLatestProfileCache(connectedAddress);
      setProfile(null);
      setProfileOverrideId('');
      setProfileOverrideInput('');

      const prevProfileId = localStorage.getItem(`streamvault:lastProfileId:${prev}`) || '';
      const route = String(routeProfileRef || '').toLowerCase();
      if (route && prevProfileId && route === prevProfileId.toLowerCase()) {
        const goToProfile = (target: string) => navigate(`/profile/${target}`, { replace: true });
        const cachedForWallet =
          localStorage.getItem(`streamvault:lastProfileId:${connected}`) || '';
        if (cachedForWallet) {
          goToProfile(cachedForWallet);
        } else if (libs && isReady && connectedAddress) {
          void getSelectedOrLatestProfileByWallet(libs, connectedAddress, {
            useOverride: true,
            timeoutMs: 15_000,
          }).then((resolved) => {
            if (resolved?.id) {
              localStorage.setItem(
                `streamvault:lastProfileId:${connected}`,
                String(resolved.id)
              );
              goToProfile(String(resolved.id));
              return;
            }
            goToProfile(connectedAddress);
          });
        } else if (connectedAddress) {
          goToProfile(connectedAddress);
        }
      }
    }

    if (!connectedAddress) {
      clearProfileSessionCaches();
      setProfile(null);
    } else {
      prevConnectedAddressRef.current = connected;
    }
  }, [connectedAddress, isReady, libs, navigate, routeProfileRef]);

  useEffect(() => {
    if (!isWalletRoute || !cachedOwnProfileId) return;
    if (routeProfileRef === cachedOwnProfileId) return;
    navigate(`/profile/${cachedOwnProfileId}`, { replace: true });
  }, [cachedOwnProfileId, isWalletRoute, navigate, routeProfileRef]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const walletsToTry = new Set<string>();
    if (connectedAddress) walletsToTry.add(connectedAddress.toLowerCase());
    if (isWalletRoute && routeProfileRef) walletsToTry.add(routeProfileRef.toLowerCase());
    const route = String(routeProfileRef || '').toLowerCase();
    for (const wallet of walletsToTry) {
      try {
        const raw = localStorage.getItem(getProfileSnapshotKey(wallet));
        if (!raw) continue;
        const snapshot = JSON.parse(raw);
        if (!snapshot?.id || !profileOwnedByWallet(snapshot, wallet)) continue;
        const snapshotId = String(snapshot.id).toLowerCase();
        if (route && route !== wallet && route !== snapshotId) continue;
        setProfile((prev) => (prev?.id ? prev : snapshot));
        PROFILE_CACHE.set(wallet, snapshot);
        PROFILE_CACHE.set(snapshotId, snapshot);
        if (route) PROFILE_CACHE.set(route, snapshot);
        break;
      } catch {
        // ignore snapshot parse errors
      }
    }
  }, [connectedAddress, isWalletRoute, routeProfileRef]);

  const isOwn = useMemo(() => {
    if (!connectedAddress) return false;
    const connected = connectedAddress.toLowerCase();
    const route = String(routeProfileRef || '').toLowerCase();
    if (route && route === connected) return true;
    if (profileWalletAddress && profileWalletAddress.toLowerCase() === connected) return true;
    if (cachedOwnProfileId && route && route === cachedOwnProfileId.toLowerCase()) return true;
    if (normalizedProfile?.id && route === String(normalizedProfile.id).toLowerCase()) {
      const owner = profileWalletAddress || inferProfileWalletAddress(normalizedProfile, null);
      if (owner && owner.toLowerCase() === connected) return true;
    }
    return false;
  }, [connectedAddress, profileWalletAddress, routeProfileRef, cachedOwnProfileId, normalizedProfile]);

  const uploadWalletAddress = useMemo(() => {
    if (profileWalletAddress) return profileWalletAddress;
    if (isOwn && connectedAddress) return connectedAddress;
    if (routeProfileRef && looksLikeWalletAddress(routeProfileRef)) return routeProfileRef;
    return null;
  }, [profileWalletAddress, connectedAddress, isOwn, routeProfileRef]);

  useEffect(() => {
    if (searchParams.get('edit') !== '1' || !normalizedProfile?.id || !isOwn) return;
    setEditOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next, { replace: true });
  }, [isOwn, normalizedProfile?.id, searchParams, setSearchParams]);

  const resolvedAddress = useMemo(() => {
    if (profileWalletAddress) return profileWalletAddress;
    if (isOwn && connectedAddress) return connectedAddress;
    return routeProfileRef || null;
  }, [connectedAddress, isOwn, profileWalletAddress, routeProfileRef]);

  const avatarRaw = useMemo(
    () =>
      normalizedProfile?.thumbnail ||
      normalizedProfile?.Thumbnail ||
      normalizedProfile?.avatar ||
      normalizedProfile?.image ||
      normalizedProfile?.profileImage ||
      normalizedProfile?.ProfileImage ||
      null,
    [normalizedProfile]
  );

  const bannerRaw = useMemo(
    () =>
      normalizedProfile?.banner ||
      normalizedProfile?.Banner ||
      normalizedProfile?.cover ||
      normalizedProfile?.Cover ||
      normalizedProfile?.coverImage ||
      normalizedProfile?.CoverImage ||
      null,
    [normalizedProfile]
  );

  const {
    src: activeAvatarSource,
    sources: avatarSources,
    sourceIndex: avatarSourceIndex,
    onError: handleAvatarImageError,
  } = useArweaveMediaSources(avatarRaw);

  const {
    src: activeBannerSource,
    sources: bannerSources,
    sourceIndex: bannerSourceIndex,
    onError: handleBannerImageError,
  } = useArweaveMediaSources(bannerRaw);

  useEffect(() => {
    if (!profileDebug) return;
    console.info('[profile] media candidates', {
      avatarSources,
      bannerSources,
      avatarSourceIndex,
      bannerSourceIndex,
    });
  }, [avatarSources, bannerSources, avatarSourceIndex, bannerSourceIndex, profileDebug]);

  const handleAvatarImageErrorWithLog = useCallback(() => {
    if (activeAvatarSource) {
      console.warn('[profile] avatar image failed', {
        url: activeAvatarSource,
        next: avatarSources[avatarSourceIndex + 1] || null,
      });
    }
    handleAvatarImageError();
  }, [activeAvatarSource, avatarSourceIndex, avatarSources, handleAvatarImageError]);

  const handleBannerImageErrorWithLog = useCallback(() => {
    if (activeBannerSource) {
      console.warn('[profile] banner image failed', {
        url: activeBannerSource,
        next: bannerSources[bannerSourceIndex + 1] || null,
      });
    }
    handleBannerImageError();
  }, [activeBannerSource, bannerSourceIndex, bannerSources, handleBannerImageError]);

  const handleAvatarImageLoad = useCallback(() => {
    if (activeAvatarSource) console.info('[profile] avatar image loaded', activeAvatarSource);
  }, [activeAvatarSource]);

  const handleBannerImageLoad = useCallback(() => {
    if (activeBannerSource) console.info('[profile] banner image loaded', activeBannerSource);
  }, [activeBannerSource]);

  const profileAssets = useMemo(
    () => (normalizedProfile ? collectProfileAssetRefs(normalizedProfile) : []),
    [normalizedProfile]
  );

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
  const bioPreviewLimit = 140;
  const bioNeedsExpand = Boolean(profileBio && profileBio.length > bioPreviewLimit);
  const profileBioPreview = useMemo(() => {
    if (!profileBio) return '';
    if (bioExpanded || !bioNeedsExpand) return profileBio;
    return `${profileBio.slice(0, bioPreviewLimit).trim()}…`;
  }, [bioExpanded, bioNeedsExpand, profileBio]);
  const hasIdentity = useMemo(
    () =>
      Boolean(
        activeAvatarSource ||
        activeBannerSource ||
        profileHandle ||
        profileBio ||
        (profileName && profileName !== 'Unnamed')
      ),
    [activeAvatarSource, activeBannerSource, profileHandle, profileBio, profileName]
  );
  const walletProfileFallback = useMemo(
    () => Boolean(isWalletRoute && isReady && !loading && !normalizedProfile?.id),
    [isWalletRoute, isReady, loading, normalizedProfile?.id]
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
  }, [routeProfileRef, normalizedProfile?.id]);

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
    const onProfileUpdated = (event: Event) => {
      const custom = event as CustomEvent<{ address?: string; profile?: any }>;
      const nextProfile = custom.detail?.profile;
      if (!nextProfile?.id) return;
      const route = String(routeProfileRef || '').toLowerCase();
      const profileId = String(nextProfile.id).toLowerCase();
      const owner = String(
        nextProfile.walletAddress ||
        nextProfile.owner ||
        nextProfile.WalletAddress ||
        nextProfile.Owner ||
        custom.detail?.address ||
        ''
      ).toLowerCase();
      if (route && (route === profileId || route === owner)) {
        setProfile(nextProfile);
        PROFILE_CACHE.set(routeProfileRef!, nextProfile);
        PROFILE_CACHE.set(String(nextProfile.id), nextProfile);
      }
    };
    window.addEventListener('streamvault:profile-updated', onProfileUpdated as EventListener);
    return () => window.removeEventListener('streamvault:profile-updated', onProfileUpdated as EventListener);
  }, [routeProfileRef]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!routeProfileRef) {
        profileLog('[profile] skip fetch: missing route :address', { isReady, hasLibs: Boolean(libs) });
        return;
      }
      if (profileSaveInFlightRef.current) {
        profileLog('[profile] skip fetch: profile save in flight');
        return;
      }
      if (!isReady) {
        profileLog('[profile] skip fetch: permaweb not ready yet', { routeProfileRef });
        if (
          connectedAddress &&
          routeProfileRef &&
          routeProfileRef.toLowerCase() === connectedAddress.toLowerCase()
        ) {
          setLoading(true);
        }
        return;
      }
      if (!libs) {
        profileLog('[profile] skip fetch: libs is null (unexpected after isReady)', { routeProfileRef });
        return;
      }
      const cached = PROFILE_CACHE.get(routeProfileRef);
      if (cached?.id) {
        setProfile(cached);
        setLoading(false);
      } else if (typeof window !== 'undefined') {
        const snapshotWallet = connectedAddress || null;
        let hydrated = false;
        if (snapshotWallet) {
          try {
            const snapshotRaw = localStorage.getItem(getProfileSnapshotKey(snapshotWallet));
            if (snapshotRaw) {
              const snapshot = JSON.parse(snapshotRaw);
              if (snapshot?.id && profileOwnedByWallet(snapshot, snapshotWallet)) {
                setProfile(snapshot);
                PROFILE_CACHE.set(routeProfileRef, snapshot);
                PROFILE_CACHE.set(String(snapshot.id), snapshot);
                hydrated = true;
                setLoading(false);
              }
            }
          } catch {
            // ignore snapshot parse errors
          }
        }
        if (!hydrated) {
          setLoading(true);
        }
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        profileLog('[profile] fetch start', {
          ref: routeProfileRef,
          resolvedAddress: resolvedAddress?.slice(0, 12),
          connected: connectedAddress?.slice(0, 12),
        });
        const overrideId = connectedAddress ? getStoredProfileOverrideId(connectedAddress) : '';
        if (overrideId) {
          setProfileOverrideId(overrideId);
          setProfileOverrideInput(overrideId);
        }
        const connected = connectedAddress;
        const isWalletAsRoute =
          Boolean(routeProfileRef && connected) &&
          isLikelyArweaveAddressRef(routeProfileRef) &&
          routeProfileRef.toLowerCase() === connected!.toLowerCase();
        const knownZoneId =
          overrideId ||
          (cachedOwnProfileId && cachedOwnProfileId !== routeProfileRef ? cachedOwnProfileId : '');
        let p: PermaProfile | null = null;
        if (isWalletAsRoute && connectedAddress) {
          p = await getSelectedOrLatestProfileByWallet(libs, connectedAddress, {
            useOverride: true,
            timeoutMs: 15_000,
          });
        }
        if (!p?.id && knownZoneId) {
          p = await getProfileByIdSafe(libs, knownZoneId, { timeoutMs: 15_000 });
        }
        if (!p?.id && routeProfileRef && !isWalletAsRoute) {
          p = await getProfileByIdSafe(libs, routeProfileRef, { timeoutMs: 15_000 });
        }
        profileLog('[profile] data', p);
        profileLog('[profile] fetch result', { hasProfile: Boolean(p?.id) });
        if (!cancelled) {
          const fetched = p?.id ? p : null;
          const prev = profileRef.current;
          const route = routeProfileRef.toLowerCase();
          const connected = connectedAddress?.toLowerCase();
          const prevOwner = inferProfileWalletAddress(prev, null)?.toLowerCase();
          const keepPrev =
            Boolean(prev?.id) &&
            ((prev?.id && String(prev.id).toLowerCase() === route) ||
              (connected &&
                prevOwner === connected &&
                prev &&
                profileOwnedByWallet(prev, connectedAddress)));
          let next: PermaProfile | { id: null } = fetched?.id
            ? fetched
            : keepPrev && prev
              ? prev
              : { id: null };
          setProfile(next);
          if (next?.id) {
            PROFILE_CACHE.set(routeProfileRef, next);
            PROFILE_CACHE.set(String(next.id), next);
          }
          const canonicalPath = shouldCanonicalizeProfileRoute(routeProfileRef, next);
          if (canonicalPath) {
            navigate(canonicalPath, { replace: true });
          }
          const walletForSnapshot = inferProfileWalletAddress(next, resolvedAddress);
          if (walletForSnapshot && next?.id && typeof window !== 'undefined') {
            try {
              localStorage.setItem(getProfileSnapshotKey(walletForSnapshot), JSON.stringify(next));
              if (connectedAddress && profileOwnedByWallet(next, connectedAddress)) {
                localStorage.setItem(
                  `streamvault:lastProfileId:${connectedAddress.toLowerCase()}`,
                  String(next.id)
                );
              }
            } catch {
              // ignore storage failures
            }
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
  }, [isReady, libs, routeProfileRef, connectedAddress, cachedOwnProfileId, walletType, navigate]);

  useEffect(() => {
    if (!isReady || !libs || !connectedAddress || !isWalletRoute || normalizedProfile?.id || loading) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getSelectedOrLatestProfileByWallet(libs, connectedAddress, {
        useOverride: true,
        timeoutMs: 15_000,
      }).then((resolved) => {
        if (cancelled || !resolved?.id) return;
        setProfile(resolved);
        PROFILE_CACHE.set(routeProfileRef!, resolved);
        PROFILE_CACHE.set(String(resolved.id), resolved);
        localStorage.setItem(
          `streamvault:lastProfileId:${connectedAddress.toLowerCase()}`,
          String(resolved.id)
        );
        const canonicalPath = shouldCanonicalizeProfileRoute(routeProfileRef, resolved);
        if (canonicalPath) navigate(canonicalPath, { replace: true });
      });
    }, 1200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    connectedAddress,
    isReady,
    isWalletRoute,
    libs,
    loading,
    navigate,
    normalizedProfile?.id,
    routeProfileRef,
  ]);

  useEffect(() => {
    if (!normalizedProfile?.id || !routeProfileRef) return;
    const canonicalPath = shouldCanonicalizeProfileRoute(routeProfileRef, normalizedProfile);
    if (canonicalPath) navigate(canonicalPath, { replace: true });
  }, [navigate, normalizedProfile, routeProfileRef]);

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
        const assets = profileAssets;
        const profileId = normalizedProfile?.id ? String(normalizedProfile.id) : '';
        if (!libs || assets.length === 0) {
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
          const resolved = await resolveProfileTokens(libs, assets, getProfileReadLibs(libs));
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
  }, [libs, profileAssets, normalizedProfile?.id]);

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

  const reloadDeviceUploads = useCallback(() => {
    if (typeof window === 'undefined') {
      setLocalSamples([]);
      return;
    }
    const wallet = uploadWalletAddress;
    if (!wallet) {
      setLocalSamples([]);
      return;
    }
    try {
      const addrs = new Set<string>();
      addrs.add(wallet.toLowerCase());
      if (connectedAddress && connectedAddress.toLowerCase() !== wallet.toLowerCase()) {
        addrs.add(connectedAddress.toLowerCase());
      }
      const byTx = new Map<string, LocalSample>();
      for (const addr of addrs) {
        for (const key of [`streamvault:myTracks:${addr}`, `streamvault:samples:${addr}`]) {
          const stored = JSON.parse(localStorage.getItem(key) || '[]') as unknown[];
          for (const s of stored) {
            const normalized = normalizeUploadedTrackRecord(s);
            if (normalized?.txId) byTx.set(normalized.txId, normalized);
          }
        }
      }
      const ledger = readUploadLedger([wallet, connectedAddress]);
      for (const e of ledger) {
        const normalized = normalizeUploadedTrackRecord(e);
        if (!normalized?.txId) continue;
        if (e.tier === 'sample') continue;
        byTx.set(normalized.txId, normalized);
      }
      setLocalSamples(
        Array.from(byTx.values()).sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
      );
    } catch {
      setLocalSamples([]);
    }
  }, [uploadWalletAddress, connectedAddress]);

  useEffect(() => {
    reloadDeviceUploads();
  }, [reloadDeviceUploads]);

  useEffect(() => {
    let cancelled = false;
    if (!uploadWalletAddress) {
      setChainProfileUploads([]);
      setChainAtomicAssets([]);
      return;
    }
    void Promise.all([
      queryPermanentUploadsByOwner(uploadWalletAddress, 50),
      queryAtomicAssetsByCreator(uploadWalletAddress, 50),
    ])
      .then(([uploads, assets]) => {
        if (!cancelled) {
          setChainProfileUploads(uploads);
          setChainAtomicAssets(assets);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setChainProfileUploads([]);
          setChainAtomicAssets([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [uploadWalletAddress]);

  useEffect(() => {
    const onUpdate = () => {
      reloadDeviceUploads();
      if (!uploadWalletAddress) return;
      void Promise.all([
        queryPermanentUploadsByOwner(uploadWalletAddress, 50),
        queryAtomicAssetsByCreator(uploadWalletAddress, 50),
      ]).then(([uploads, assets]) => {
        setChainProfileUploads(uploads);
        setChainAtomicAssets(assets);
      }).catch(() => {
        setChainProfileUploads([]);
        setChainAtomicAssets([]);
      });
    };
    window.addEventListener('streamvault:profile-updated', onUpdate);
    window.addEventListener('streamvault:uploads-updated', onUpdate);
    return () => {
      window.removeEventListener('streamvault:profile-updated', onUpdate);
      window.removeEventListener('streamvault:uploads-updated', onUpdate);
    };
  }, [reloadDeviceUploads, uploadWalletAddress]);

  useEffect(() => {
    let cancelled = false;
    if (!uploadWalletAddress || !isOwn) {
      setAoPublishedTracks([]);
      return;
    }
    (async () => {
      try {
        const addrs = [uploadWalletAddress];
        if (connectedAddress && connectedAddress.toLowerCase() !== uploadWalletAddress.toLowerCase()) {
          addrs.push(connectedAddress);
        }
        const map = new Map<string, RegisteredTrackRecord>();
        for (const a of addrs) {
          const rows = await searchTracksOnAO({ creator: a });
          for (const r of rows) {
            const k = r.assetId || r.audioTxId;
            if (k) map.set(k, r);
          }
        }
        if (!cancelled) setAoPublishedTracks(Array.from(map.values()));
      } catch {
        if (!cancelled) setAoPublishedTracks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uploadWalletAddress, connectedAddress, isOwn]);

  /** On-chain list from profile zone (ArweaveTracks preferred; Samples kept for older profiles). */
  const profileArweaveTracks = useMemo(() => {
    const chunks: unknown[] = [
      normalizedProfile?.arweaveTracks,
      normalizedProfile?.ArweaveTracks,
      normalizedProfile?.samples,
      normalizedProfile?.Samples,
    ];
    const byTx = new Map<string, LocalSample>();
    for (const raw of chunks) {
      const arr = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
      for (const row of arr) {
        const normalized = normalizeUploadedTrackRecord(row);
        if (!normalized?.txId) continue;
        const prev = byTx.get(normalized.txId);
        byTx.set(normalized.txId, {
          ...prev,
          ...normalized,
          createdAt: normalized.createdAt || prev?.createdAt || new Date(0).toISOString(),
          title: normalized.title || prev?.title || 'Untitled',
          artist: normalized.artist || prev?.artist || '',
        });
      }
    }
    return Array.from(byTx.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [normalizedProfile]);

  const mergedProfileUploads = useMemo(() => {
    const byTx = new Map<string, UploadedTrackRecord>();
    for (const row of profileArweaveTracks) byTx.set(row.txId, row);
    for (const row of localSamples) {
      const prev = byTx.get(row.txId);
      byTx.set(row.txId, { ...prev, ...row });
    }
    for (const row of chainProfileUploads) {
      const prev = byTx.get(row.txId);
      byTx.set(row.txId, {
        ...prev,
        ...row,
        assetId: row.assetId || prev?.assetId,
        walletAddress: row.walletAddress || prev?.walletAddress || uploadWalletAddress || undefined,
      });
    }
    for (const asset of chainAtomicAssets) {
      if (asset.audioTxId) {
        const prev = byTx.get(asset.audioTxId);
        byTx.set(asset.audioTxId, {
          ...prev,
          txId: asset.audioTxId,
          title: prev?.title || asset.title,
          artist: prev?.artist || asset.artist,
          assetId: asset.assetId,
          artworkTxId: prev?.artworkTxId || asset.artworkTxId,
          walletAddress: prev?.walletAddress || asset.walletAddress || uploadWalletAddress || undefined,
          createdAt: prev?.createdAt || asset.createdAt || new Date(0).toISOString(),
          permawebUrl: prev?.permawebUrl || arweaveTxDataUrl(asset.audioTxId),
        });
      }
    }
    for (const row of aoPublishedTracks) {
      const prev = byTx.get(row.audioTxId);
      byTx.set(row.audioTxId, {
        ...prev,
        txId: row.audioTxId,
        title: row.tags?.Title || prev?.title || 'Untitled',
        artist: row.tags?.Artist || prev?.artist || '',
        assetId: row.assetId || prev?.assetId,
        createdAt: row.createdAt ? new Date(row.createdAt * 1000).toISOString() : prev?.createdAt || new Date(0).toISOString(),
        walletAddress: row.creator || prev?.walletAddress,
        permawebUrl: prev?.permawebUrl || arweaveTxDataUrl(row.audioTxId),
        udl: row.udl
          ? {
              licenseId: row.udl.licenseId,
              usage: row.udl.usage,
              aiUse: row.udl.aiUse,
              fee: row.udl.fee,
              currency: row.udl.currency,
              interval: row.udl.interval,
              attribution: row.udl.attribution,
              uri: row.udl.uri,
            }
          : prev?.udl,
      });
    }
    return Array.from(byTx.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }, [aoPublishedTracks, chainAtomicAssets, chainProfileUploads, localSamples, profileArweaveTracks, uploadWalletAddress]);

  const useUnifiedMusicGrid = visibleAudiusTracks.length > 0;

  /** Arweave uploads not paired with a visible Audius row (hidden when unified grid omitted them). */
  const arweaveOnlyProfileUploads = useMemo(() => {
    if (!useUnifiedMusicGrid) return mergedProfileUploads;
    const matchedTxIds = new Set<string>();
    for (const track of visibleAudiusTracks) {
      const playable = toPlayableTrack(track);
      const matched = matchUploadedTrackToAudiusTrack(mergedProfileUploads, playable);
      if (matched) matchedTxIds.add(matched.txId);
    }
    return mergedProfileUploads.filter((upload) => !matchedTxIds.has(upload.txId));
  }, [mergedProfileUploads, useUnifiedMusicGrid, visibleAudiusTracks]);

  const visibleProfileUploads = useMemo(
    () => (useUnifiedMusicGrid ? arweaveOnlyProfileUploads : mergedProfileUploads),
    [arweaveOnlyProfileUploads, mergedProfileUploads, useUnifiedMusicGrid]
  );

  const displayAtomicAssets = useMemo(() => {
    const inTrackGrid = new Set(
      mergedProfileUploads.map((upload) => String(upload.assetId || '').trim()).filter(Boolean)
    );
    return atomicAssets.filter((asset) => asset.id && !inTrackGrid.has(asset.id));
  }, [atomicAssets, mergedProfileUploads]);

  const handleAddSample = async () => {
    if (!libs?.addToZone || !normalizedProfile?.id || walletType !== 'arweave') return;
    const txId = newSampleTxId.trim();
    if (!txId) return;
    try {
      await libs.addToZone(
        {
          path: 'ArweaveTracks[]',
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
    if (!normalizedProfile?.audiusHandle || !normalizedProfile?.id) return;
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
      const signerWallet = resolveArweaveSigner(arweaveApi);
      if (walletType === 'arweave') {
        await connectArweaveSignerForProfile(signerWallet);
        const writableLibs = await getWritableProfileLibs(getWritableLibs);
        await applyProfileZoneExtras(
          writableLibs,
          normalizedProfile.id,
          {
            audiusHandle: String(normalizedProfile.audiusHandle),
            audiusProof: JSON.stringify(proof),
          },
          normalizedProfile
        );
      }
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
      const signerWallet = resolveArweaveSigner(arweaveApi);
      if (!signerWallet) throw new Error('Arweave signer unavailable.');

      const permissionsBefore = await signerWallet.getPermissions?.().catch(() => null);
      await connectArweaveSignerForProfile(signerWallet);
      const permissionsAfter = await signerWallet.getPermissions?.().catch(() => null);

      const signerAddress = await signerWallet.getActiveAddress?.().catch(() => null);
      const profileRecord =
        normalizedProfile?.id
          ? { id: normalizedProfile.id }
          : await getSelectedOrLatestProfileByWallet(libs, connectedAddress);
      if (!profileRecord?.id) {
        throw new Error('Create an Arweave profile first, then link your Audius identity.');
      }
      const profileScheduler = await resolveProfileScheduler(normalizedProfile || profileRecord);
      const writeNodeUrls = resolveProfileZoneWriteNodeUrls();
      const writeUrl = writeNodeUrls[0];
      profileLog('[profile] zone extras scheduler', {
        profileId: profileRecord.id,
        scheduler: profileScheduler || 'default',
        writeUrl: writeUrl || 'default',
      });
      const writableLibs = await getWritableProfileLibs(
        getWritableLibs,
        {
          ...(profileScheduler ? { scheduler: profileScheduler } : {}),
          ...(writeUrl ? { url: writeUrl } : {}),
        }
      );
      await applyProfileZoneExtras(
        writableLibs,
        profileRecord.id,
        {
          audiusHandle: String(audiusUser.handle || '').trim(),
        },
        profileRecord
      );

      setProfile((prev) => (prev ? { ...prev, audiusHandle: audiusUser.handle } : prev));
      window.dispatchEvent(new CustomEvent('streamvault:profile-updated'));
      setLinkAudiusDebug({
        status: 'success',
        usedPath: 'permaweb-libs-zone-extras',
        signerSource: (typeof window !== 'undefined' && (window as any).arweaveWallet) ? 'injected' : 'wallet-kit-api',
        signerAddress,
        permissionsBefore,
        permissionsAfter,
        connectedAddress,
        profileId: profileRecord.id,
        audiusHandle: audiusUser.handle,
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
    audiusHandle?: string;
    thumbnail?: File | null;
    banner?: File | null;
    thumbnailValue?: string | null;
    bannerValue?: string | null;
    removeThumbnail?: boolean;
    removeBanner?: boolean;
  }) => {
    if (!libs || !connectedAddress || walletType !== 'arweave') return;
    setCreating(true);
    setError(null);
    try {
      profileLog('[profile] create start', { address: connectedAddress, audiusHandle: form.audiusHandle });
      const existing = await getSelectedOrLatestProfileByWallet(libs, connectedAddress);
      if (existing?.id) {
        profileLog('[profile] existing profile found', { profileId: existing.id });
        setProfile(existing);
        setCreateOpen(false);
        return;
      }

      const signerWallet = resolveArweaveSigner(arweaveApi);
      if (!signerWallet) throw new Error('Arweave signer unavailable. Connect Wander and retry.');
      await connectArweaveSignerForProfile(signerWallet);
      const writeNodeUrls = resolveProfileZoneWriteNodeUrls();
      const writeUrl = writeNodeUrls[0];
      profileLog('[profile] create write nodes', { writeUrl, writeNodeUrls });
      const writableLibs = await getWritableProfileLibs(getWritableLibs, writeUrl ? { url: writeUrl } : undefined);
      const args = await buildPermawebProfileArgs(form, fileToDataURL, writableLibs);

      const profileId = await createPermawebProfile({
        writableLibs,
        profileArgs: args,
        getWritableLibs,
        writeOptions: {
          ...(writeUrl ? { url: writeUrl } : {}),
          writeNodeUrls,
        },
        onStatus: (status: unknown) => {
          profileLog('[profile] create status', status);
        },
      });
      profileLog('[profile] create success', { profileId });
      if (!profileId) throw new Error('permaweb-libs createProfile returned no profile id.');

      if (form.audiusHandle?.trim()) {
        await applyProfileZoneExtras(writableLibs, profileId, {
          audiusHandle: form.audiusHandle.trim(),
        });
      }

      const next = {
        id: profileId,
        walletAddress: connectedAddress,
        username: args.username,
        displayName: args.displayName,
        description: args.description,
        ...(form.audiusHandle?.trim() ? { audiusHandle: form.audiusHandle.trim() } : {}),
      };
      setProfile(next);
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(getProfileSnapshotKey(connectedAddress), JSON.stringify(next));
          localStorage.setItem(
            `streamvault:lastProfileId:${connectedAddress.toLowerCase()}`,
            String(profileId)
          );
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

      if (localSamples.length > 0 && writableLibs.addToZone) {
        setSyncing(true);
        try {
          for (const sample of localSamples) {
            await writableLibs.addToZone(
              {
                path: 'ArweaveTracks[]',
                data: sample,
              },
              profileId
            );
          }
          profileLog('[profile] local Arweave tracks synced', { count: localSamples.length });
        } catch (e) {
          console.warn('[profile] Failed to sync Arweave tracks', e);
        } finally {
          setSyncing(false);
        }
      }

      try {
        const fresh = await refreshProfileAfterWrite({
          readLibs: libs,
          profileId: String(profileId),
          connectedAddress,
          optimistic: next,
        });
        if (fresh) setProfile(fresh);
      } catch {
        // keep optimistic profile
      }
    } catch (e: any) {
      console.error('[profile] create failed', e);
      setError(e?.message || 'Profile creation failed');
    } finally {
      setCreating(false);
    }
  };

  const handleEditProfile = async (form: {
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
    if (!normalizedProfile?.id || walletType !== 'arweave' || !connectedAddress) return;
    setCreating(true);
    setError(null);
    profileSaveInFlightRef.current = true;

    const profileId = String(normalizedProfile.id);

    const persistConfirmedProfile = (onChain: any) => {
      setProfile(onChain);
      PROFILE_CACHE.set(profileId, onChain);
      if (routeProfileRef) PROFILE_CACHE.set(routeProfileRef, onChain);
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(getProfileSnapshotKey(connectedAddress), JSON.stringify(onChain));
          localStorage.setItem(
            `streamvault:lastProfileId:${connectedAddress.toLowerCase()}`,
            profileId
          );
        } catch {
          // ignore storage failures
        }
        window.dispatchEvent(
          new CustomEvent('streamvault:profile-updated', {
            detail: { address: connectedAddress, profile: onChain },
          })
        );
      }
      setEditOpen(false);
      setError(null);
    };

    try {
      // #region agent log
      const _dbgFetch = globalThis.fetch.bind(globalThis);
      _dbgFetch('http://127.0.0.1:7875/ingest/e73f4289-b39c-483d-adc2-eb8e696a88dd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '935ac8' },
        body: JSON.stringify({
          sessionId: '935ac8',
          runId: 'pre-fix',
          hypothesisId: 'H0',
          location: 'Profile.tsx:handleEditProfile',
          message: 'edit save start',
          data: { profileId, walletType, hasConnectedAddress: Boolean(connectedAddress) },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      const signerWallet = resolveArweaveSigner(arweaveApi);
      await connectArweaveSignerForProfile(signerWallet);

      const profileScheduler = await resolveProfileScheduler(normalizedProfile);
      const writeNodeUrls = resolveProfileZoneWriteNodeUrls();
      const writeUrl = writeNodeUrls[0];
      profileLog('[profile] edit scheduler', {
        profileId,
        scheduler: profileScheduler || 'default',
        writeUrl: writeUrl || 'default',
        writeNodeUrls,
      });
      const writableLibs = await getWritableProfileLibs(
        getWritableLibs,
        {
          ...(profileScheduler ? { scheduler: profileScheduler } : {}),
          ...(writeUrl ? { url: writeUrl } : {}),
        }
      );
      const writeOptions = {
        ...(profileScheduler ? { scheduler: profileScheduler } : {}),
        ...(writeUrl ? { url: writeUrl } : {}),
        writeNodeUrls,
      };
      const args = await buildPermawebProfileArgsWithTimeout(form, fileToDataURL, writableLibs, normalizedProfile);

      profileLog('[profile] edit updateZone', {
        profileId,
        args,
        thumbnailRef: args.thumbnail?.slice(0, 12),
        bannerRef: args.banner?.slice(0, 12),
      });

      const onChain = await writeAndConfirmProfileUpdate({
        writableLibs,
        readLibs: libs,
        profileArgs: args,
        profileId,
        form,
        getWritableLibs,
        writeOptions,
        onStatus: (status) => profileLog('[profile] update status', status),
      });

      if (form.audiusHandle?.trim()) {
        await applyProfileZoneExtras(
          writableLibs,
          profileId,
          { audiusHandle: form.audiusHandle.trim() },
          normalizedProfile
        );
      }

      persistConfirmedProfile(onChain);
    } catch (e: any) {
      // #region agent log
      const _dbgFetch = globalThis.fetch.bind(globalThis);
      _dbgFetch('http://127.0.0.1:7875/ingest/e73f4289-b39c-483d-adc2-eb8e696a88dd', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '935ac8' },
        body: JSON.stringify({
          sessionId: '935ac8',
          runId: 'pre-fix',
          hypothesisId: 'H0',
          location: 'Profile.tsx:handleEditProfile',
          message: 'edit save failed',
          data: { profileId, error: String(e?.message || e) },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
      // #endregion
      console.error('[profile] edit failed', e);
      setError(e?.message || 'Profile update failed. Your on-chain profile was not changed.');
    } finally {
      profileSaveInFlightRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div className={styles.page}>
      <section className={styles.profileHero + ' glass'}>
        {activeBannerSource && (
          <img
            className={styles.profileHeroBanner}
            src={activeBannerSource}
            alt=""
            onError={handleBannerImageErrorWithLog}
            onLoad={handleBannerImageLoad}
          />
        )}
        <div className={styles.profileHeroOverlay} aria-hidden />
        <div className={styles.profileHeroTopActions}>
          <button
            type="button"
            className={styles.profileHeroShareBtn}
            onClick={handleCopyShareUrl}
            title="Copy profile link"
          >
            <ShareIcon />
            {copiedShareUrl ? 'Copied' : 'Share'}
          </button>
          {walletType === 'arweave' && isOwn && (
            <button
              type="button"
              className={styles.profileHeroEditBtn}
              onClick={() => (normalizedProfile?.id ? setEditOpen(true) : setCreateOpen(true))}
            >
              {normalizedProfile?.id ? 'Edit profile' : 'Create profile'}
            </button>
          )}
        </div>
        <div className={styles.profileHeroContent}>
          {activeAvatarSource ? (
            <img
              className={styles.profileHeroAvatar}
              src={activeAvatarSource}
              alt=""
              onError={handleAvatarImageErrorWithLog}
              onLoad={handleAvatarImageLoad}
            />
          ) : (
            <div className={styles.profileHeroAvatarPlaceholder} aria-hidden />
          )}
          <div className={styles.profileHeroText}>
            <h1 className={styles.profileHeroTitle}>
              {hasIdentity ? profileName : isOwn ? 'Your profile' : 'Creator profile'}
            </h1>
            {profileHandle && <p className={styles.profileHeroHandle}>@{profileHandle}</p>}
            <div className={styles.profileHeroIdRow}>
              <p className={styles.profileHeroMeta}>
                {normalizedProfile?.id
                  ? `${String(normalizedProfile.id).slice(0, 8)}…${String(normalizedProfile.id).slice(-8)}`
                  : resolvedAddress
                    ? `${String(resolvedAddress).slice(0, 8)}…${String(resolvedAddress).slice(-8)}`
                    : 'Resolving…'}
              </p>
              {normalizedProfile?.id && (
                <button
                  type="button"
                  className={styles.profileHeroCopyBtn}
                  onClick={handleCopyProfileId}
                  title="Copy profile ID"
                  aria-label={copiedProfileId ? 'Copied profile ID' : 'Copy profile ID'}
                >
                  <CopyIcon />
                </button>
              )}
            </div>
            {profileBio ? (
              <p className={styles.profileHeroBio}>
                {profileBioPreview}
                {bioNeedsExpand && (
                  <button
                    type="button"
                    className={styles.profileHeroBioExpand}
                    onClick={() => setBioExpanded((v) => !v)}
                  >
                    {bioExpanded ? ' less' : '…more'}
                  </button>
                )}
              </p>
            ) : (
              <p className={styles.profileHeroBioMuted}>No description yet.</p>
            )}
          </div>
        </div>
      </section>
      {walletProfileFallback && (
        <section className={styles.fallbackNotice}>
          <p className={styles.fallbackTitle}>Wallet profile fallback active</p>
          <p className={styles.subtext}>
            StreamVault is showing the wallet-based profile view while the permanent permaweb profile data is unavailable or still resolving.
          </p>
        </section>
      )}
      {loading && walletType === 'arweave' && !normalizedProfile?.id && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <LogoSpinner />
        </section>
      )}
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
                  <div className={styles.trackGrid}>
                    {visibleAudiusTracks.map((track) => {
                      const playable = toPlayableTrack(track);
                      const matchedUpload = matchUploadedTrackToAudiusTrack(mergedProfileUploads, playable);
                      const displayAudiusTrack = matchedUpload
                        ? mergeAudiusTrackWithPersistedUpload(playable, matchedUpload)
                        : playable;
                      return (
                        <TrackCard
                          key={track.id}
                          track={{
                            ...displayAudiusTrack,
                            artwork: displayAudiusTrack.artwork || getArtworkUrl(track) || undefined,
                          }}
                          showPermanentBadge={false}
                          footerContent={
                            matchedUpload ? (
                              <>
                                <span className={styles.sourcePill}>Arweave</span>
                                <UploadedTrackMeta track={matchedUpload} compact />
                              </>
                            ) : (
                              <>
                                {isOwn && (
                                  <button
                                    type="button"
                                    className={styles.copyBtn}
                                    onClick={() => setPublishTrack(playable)}
                                  >
                                    Publish
                                  </button>
                                )}
                                <span className={styles.sourcePill}>Audius</span>
                              </>
                            )
                          }
                        />
                      );
                    })}
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
      {error && !walletProfileFallback && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <p className={styles.error}>{error}</p>
        </section>
      )}

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

      {displayAtomicAssets.length > 0 && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Digital assets</h2>
          </div>
          <p className={styles.subtext}>
            Other atomic assets in your profile zone not shown as tracks below.
          </p>
          <div className={styles.sampleList}>
            {displayAtomicAssets.map((asset) => (
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

      {visibleProfileUploads.length > 0 && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>
              {useUnifiedMusicGrid ? 'Arweave uploads' : 'My tracks on Arweave'}
            </h2>
          </div>
          <p className={styles.subtext}>
            {useUnifiedMusicGrid
              ? 'Permanent uploads on your profile that are not listed in the Audius catalog above.'
              : 'Full uploads stored on your permaweb profile zone. Use arweave.net (or a stored permaweb link) to open the data tx.'}{' '}
            You can also use these clips in the{' '}
            <a href="#/vault/creator-tools" className={styles.link}>Art Engine</a>.
          </p>
          <div className={styles.trackGrid}>
            {visibleProfileUploads.map((sample) => (
              <TrackCard
                key={sample.txId}
                track={uploadedTrackToPlayerTrack(sample)}
                artistHref={sample.walletAddress ? arweaveArtistPath(sample.walletAddress) : undefined}
                showPermanentBadge={false}
                footerContent={
                  <>
                    <span className={styles.sourcePill}>Arweave</span>
                    <UploadedTrackMeta track={sample} compact />
                  </>
                }
              />
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

      {!useUnifiedMusicGrid && isOwn && aoPublishedTracks.length > 0 && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Your Arweave publishes (registry)</h2>
          </div>
          <p className={styles.subtext}>
            Tracks registered from StreamVault on your AO MusicRegistry (includes data-tx-only uploads).
          </p>
          <div className={styles.trackGrid}>
            {aoPublishedTracks.map((t) => (
              <TrackCard
                key={t.assetId || t.audioTxId}
                track={{
                  id: t.audioTxId,
                  title: t.tags?.Title || 'Untitled',
                  artist: t.tags?.Artist || 'Unknown artist',
                  artistId: t.creator,
                  streamUrl: turboTxDataUrl(t.audioTxId),
                  isPermanent: true,
                  permaTxId: t.audioTxId,
                  assetId: t.assetId,
                }}
                artistHref={t.creator ? arweaveArtistPath(t.creator) : undefined}
                showPermanentBadge={false}
                footerContent={
                  <>
                    <span className={styles.sourcePill}>Arweave</span>
                    <UploadedTrackMeta
                      track={{
                        txId: t.audioTxId,
                        title: t.tags?.Title || 'Untitled',
                        artist: t.tags?.Artist || '',
                        createdAt: new Date((t.createdAt || 0) * 1000).toISOString(),
                        udl: t.udl
                          ? {
                              licenseId: t.udl.licenseId,
                              usage: t.udl.usage,
                              aiUse: t.udl.aiUse,
                              fee: t.udl.fee,
                              currency: t.udl.currency,
                              interval: t.udl.interval,
                              attribution: t.udl.attribution,
                              uri: t.udl.uri,
                            }
                          : undefined,
                      }}
                      compact
                    />
                  </>
                }
              />
            ))}
          </div>
        </section>
      )}

      {!useUnifiedMusicGrid && localSamples.length > 0 && (
        <section className={styles.section + ' ' + styles.sectionTight}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>My tracks (this browser)</h2>
          </div>
          <p className={styles.subtext}>
            Merges the upload ledger, local myTracks storage, and legacy keys for this profile address and your
            currently connected wallet. After upload, use arweave.net (or a stored permaweb link)
            below; playback may lag until gateways index the tx.
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
          <div className={styles.trackGrid}>
            {localSamples.map((sample) => (
              <TrackCard
                key={sample.txId}
                track={uploadedSampleToTrack(sample)}
                artistHref={sample.walletAddress ? arweaveArtistPath(sample.walletAddress) : undefined}
                showPermanentBadge={false}
                footerContent={
                  <>
                    <span className={styles.sourcePill}>Arweave</span>
                    <UploadedTrackMeta track={sample} compact />
                  </>
                }
              />
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
                        href={arweaveTxDataUrl(track.audioTxId)}
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
          initialAvatarUrl={activeAvatarSource}
          initialBannerUrl={activeBannerSource}
          initialThumbnailValue={extractRawProfileMediaRef(normalizedProfile, 'thumbnail')}
          initialBannerValue={extractRawProfileMediaRef(normalizedProfile, 'banner')}
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
