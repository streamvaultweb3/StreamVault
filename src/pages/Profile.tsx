import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { usePermaweb } from '../context/PermawebContext';
import { useAudiusAuth } from '../context/AudiusAuthContext';
import { LogoSpinner } from '../components/LogoSpinner';
import { searchUsers, type AudiusUser } from '../lib/audius';
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
  getLatestProfileByWallet,
  getProfileOptionsByWallet,
  getSelectedOrLatestProfileByWallet,
  getStoredProfileOverrideId,
  setStoredProfileOverrideId,
} from '../lib/permaProfile';
import { resolveProfileTokens, type ResolvedProfileToken } from '../lib/profileTokens';
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
function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export function Profile() {
  const { address } = useParams<{ address: string }>();
  const { address: connectedAddress, walletType } = useWallet();
  const { audiusUser } = useAudiusAuth();
  const isOwn = connectedAddress && address && connectedAddress.toLowerCase() === address.toLowerCase();
  const resolvedAddress = isOwn ? connectedAddress : address;
  const { libs, isReady } = usePermaweb();

  const [profile, setProfile] = useState<PermaProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localSamples, setLocalSamples] = useState<LocalSample[]>([]);
  const [copiedTxId, setCopiedTxId] = useState<string | null>(null);
  const [audiusProfile, setAudiusProfile] = useState<AudiusUser | null>(null);
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
  const [profileTokens, setProfileTokens] = useState<ResolvedProfileToken[]>([]);
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

  const avatarSource = useMemo(() => {
    return getProfileAvatar(normalizedProfile);
  }, [normalizedProfile]);

  const bannerSource = useMemo(() => {
    return getProfileBanner(normalizedProfile);
  }, [normalizedProfile]);

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
    return `${window.location.origin}/#/profile/${address}`;
  }, [address]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isReady || !libs || !resolvedAddress) return;
      if (isOwn && !walletType) return;
      setLoading(true);
      setError(null);
      try {
        console.info('[profile] fetch start', { address: resolvedAddress });
        const overrideId =
          getStoredProfileOverrideId(resolvedAddress);
        if (overrideId) {
          setProfileOverrideId(overrideId);
          setProfileOverrideInput(overrideId);
        }
        const p = overrideId && libs.getProfileById
          ? await libs.getProfileById(overrideId)
          : await getSelectedOrLatestProfileByWallet(libs, resolvedAddress);
        console.info('[profile] data', p);
        console.info('[profile] fetch result', { hasProfile: Boolean(p?.id) });
        if (!cancelled) setProfile(p || { id: null });
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
  }, [isReady, walletType, libs, resolvedAddress, isOwn]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!libs || !resolvedAddress) return;
      if (isOwn && !walletType) return;
      try {
        console.info('[profile] options fetch start', { address: resolvedAddress });
        const options = await getProfileOptionsByWallet(libs, resolvedAddress);
        if (!cancelled) setProfileOptions(options);
      } catch (e) {
        console.error('[profile] options fetch failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libs, resolvedAddress, isOwn, walletType]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!libs?.getProfileById) return;
      if (normalizedProfile?.id) return;
      if (!profileOptions.length) return;
      try {
        // If identity hints exist but ID is missing, resolve first indexed profile as source of truth.
        const recovered = await libs.getProfileById(profileOptions[0].id);
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
    (async () => {
      if (!libs || !Array.isArray(normalizedProfile?.assets) || normalizedProfile.assets.length === 0) {
        setProfileTokens([]);
        return;
      }
      try {
        const resolved = await resolveProfileTokens(libs, normalizedProfile.assets);
        if (!cancelled) setProfileTokens(resolved);
      } catch {
        if (!cancelled) setProfileTokens([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [libs, normalizedProfile?.assets]);

  useEffect(() => {
    let cancelled = false;
    const handle = profile?.audiusHandle;
    if (!handle) {
      setAudiusProfile(null);
      return;
    }
    (async () => {
      try {
        const results = await searchUsers(handle, 1);
        if (!cancelled) setAudiusProfile(results[0] || null);
      } catch {
        if (!cancelled) setAudiusProfile(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profile?.audiusHandle]);

  useEffect(() => {
    if (!address || typeof window === 'undefined') return;
    try {
      const key = `streamvault:samples:${address.toLowerCase()}`;
      const stored = JSON.parse(localStorage.getItem(key) || '[]') as LocalSample[];
      setLocalSamples(stored);
    } catch {
      setLocalSamples([]);
    }
  }, [address]);

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
    if (!address || !walletType) return;
    setVerifying(true);
    setVerifyError(null);
    try {
      const message = `StreamVault Audius verification\nHandle: ${normalizedProfile.audiusHandle}\nWallet: ${address}\nTimestamp: ${new Date().toISOString()}`;
      let signature: string | null = null;
      if (walletType === 'ethereum' && (window as any).ethereum) {
        signature = await (window as any).ethereum.request({
          method: 'personal_sign',
          params: [message, address],
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
        address,
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
    if (!resolvedAddress || !libs?.getProfileById) return;
    const id = (nextId || profileOverrideInput).trim();
    if (!id) return;
    try {
      setLoading(true);
      const p = await libs.getProfileById(id);
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
    if (!libs?.createProfile || !address) return;
    setCreating(true);
    setError(null);
    try {
      console.info('[profile] create start', { address, audiusHandle: form.audiusHandle });
      const existing = await getSelectedOrLatestProfileByWallet(libs, address);
      if (existing?.id) {
        console.info('[profile] existing profile found', { profileId: existing.id });
        setProfile(existing);
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
      setProfile({ id: profileId, walletAddress: address, username: args.username, displayName: args.displayName, description: args.description });
      setCreateOpen(false);

      if (profileId && localSamples.length > 0 && libs.addToZone) {
        setSyncing(true);
        try {
          for (const sample of localSamples) {
            await libs.addToZone(
              {
                path: 'Samples[]',
                data: sample,
              },
              profileId
            );
          }
          console.info('[profile] local samples synced', { count: localSamples.length });
        } catch (e) {
          console.warn('[profile] Failed to sync samples', e);
        } finally {
          setSyncing(false);
        }
      }

      // Best-effort refresh (indexing may lag)
      try {
        const fresh = await getSelectedOrLatestProfileByWallet(libs, address);
        if (fresh) setProfile(fresh);
      } catch {
        // ignore - eventual consistency
      }
    } catch (e: any) {
      console.error('[profile] create failed', e);
      const msg = String(e?.message || '');
      if (msg.includes('not allowed on this SU') || msg.includes('Process') && msg.includes('not allowed')) {
        setError('Permaweb profile creation is not available on this node right now. Try again later or use an AO mainnet-enabled environment.');
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
    audiusHandle?: string;
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

      await libs.updateProfile(args, normalizedProfile.id);
      if (libs.updateZone) {
        await libs.updateZone(
          {
            Name: form.displayName.trim(),
            Handle: form.username.trim(),
            Bio: form.description.trim(),
            AudiusHandle: form.audiusHandle?.trim() || '',
          },
          normalizedProfile.id
        );
      }
      const fresh =
        (await libs.getProfileById?.(normalizedProfile.id)) ||
        (resolvedAddress ? await getSelectedOrLatestProfileByWallet(libs, resolvedAddress) : null);
      if (fresh) setProfile(fresh);
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
          <p className={styles.address}>{address?.slice(0, 8)}…{address?.slice(-8)}</p>
          {walletType && <span className={styles.walletType}>{walletType}</span>}
        </div>
      </header>
      {audiusProfile && (
        <section className={styles.section}>
          <div className={styles.profileCard}>
            <div>
              <p className={styles.profileName}>{audiusProfile.name}</p>
              <p className={styles.subtext}>Audius · @{audiusProfile.handle}</p>
            </div>
            <div className={styles.profileMeta}>
              <span className={styles.mono}>{audiusProfile.track_count} tracks</span>
              {typeof audiusProfile.playlist_count === 'number' && (
                <span className={styles.monoValue}>{audiusProfile.playlist_count} playlists</span>
              )}
            </div>
          </div>
        </section>
      )}
      <section className={styles.section}>
        <p className={styles.text}>
          Share your profile: <strong>{shareUrl}</strong>
        </p>
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
          {walletType === 'arweave' && isOwn && (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => (normalizedProfile?.id ? setEditOpen(true) : setCreateOpen(true))}
            >
              {normalizedProfile?.id ? 'Edit profile' : 'Create profile'}
            </button>
          )}
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
              <span className={styles.mono}>Profile ID</span>
              <span className={styles.monoValue}>
                {normalizedProfile?.id ? `${String(normalizedProfile.id).slice(0, 12)}…` : 'Resolving…'}
              </span>
            </div>
          </div>
        ) : (
          <p className={styles.subtext}>
            No permaweb profile found for this wallet yet. Create one to make your identity permanent and creator-first.
          </p>
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
          initialAudiusHandle={audiusProfile?.handle ?? audiusUser?.handle}
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
          initialThumbnailValue={normalizedProfile?.thumbnail || normalizedProfile?.Thumbnail || null}
          initialBannerValue={normalizedProfile?.banner || normalizedProfile?.Banner || null}
          initialAudiusHandle={normalizedProfile?.audiusHandle || audiusProfile?.handle || audiusUser?.handle}
          onCreate={handleEditProfile}
        />
      )}
    </div>
  );
}
