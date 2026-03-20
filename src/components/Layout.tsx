import React from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { useAudiusAuth } from '../context/AudiusAuthContext';
import { usePermaweb } from '../context/PermawebContext';
import {
  clearStoredProfileOverrideId,
  getProfileAvatar,
  getProfileHandle,
  getSelectedOrLatestProfileByWallet,
  getStoredProfileOverrideId,
} from '../lib/permaProfile';
import { resolveProfileTokens, type ResolvedProfileToken } from '../lib/profileTokens';
import { createPortal } from 'react-dom';
import { PublishModal } from './PublishModal';
import { WanderConnectModal } from './WanderConnectModal';
import { ensureWanderConnect, openWanderConnect } from '../lib/wanderConnect';
import { ConnectButton } from '@arweave-wallet-kit/react';
import { setUserProperties, trackEvent } from '../lib/analytics';
import styles from './Layout.module.css';

const ARWEAVE_PERMISSIONS = ['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION', 'DISPATCH'];
type ConnectStage =
  | 'idle'
  | 'initializing'
  | 'opening'
  | 'requesting'
  | 'reading_address'
  | 'awaiting_user'
  | 'connected'
  | 'error';

function connectStageText(stage: ConnectStage): string {
  switch (stage) {
    case 'initializing':
      return 'Initializing Wander Connect…';
    case 'opening':
      return 'Opening Wander wallet window…';
    case 'requesting':
      return 'Waiting for wallet approval…';
    case 'reading_address':
      return 'Reading wallet address…';
    case 'awaiting_user':
      return 'Continue in Wander window, then click again if needed.';
    case 'connected':
      return 'Connected.';
    case 'error':
      return 'Connection failed.';
    default:
      return '';
  }
}

function resolveProfileImage(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.startsWith('http') || raw.startsWith('data:')) return raw;
  return `https://arweave.net/${raw}`;
}

function getProfileSnapshotKey(walletAddress: string) {
  return `streamvault:profileSnapshot:${walletAddress.toLowerCase()}`;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { walletType, address, connect, disconnect, isConnecting } = useWallet();
  const { libs, isReady } = usePermaweb();
  const { audiusUser, login, logout, apiKeyConfigured, isLoggingIn, authError } = useAudiusAuth();
  const [showWalletMenu, setShowWalletMenu] = React.useState(false);
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [isPublishOpen, setIsPublishOpen] = React.useState(false);
  const [profileLoading, setProfileLoading] = React.useState(false);
  const [profile, setProfile] = React.useState<any | null>(null);
  const [profileTokens, setProfileTokens] = React.useState<ResolvedProfileToken[]>([]);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const [connectError, setConnectError] = React.useState<string | null>(null);
  const [showWanderConnectModal, setShowWanderConnectModal] = React.useState(false);
  const [startingWanderConnect, setStartingWanderConnect] = React.useState(false);
  const [connectStage, setConnectStage] = React.useState<ConnectStage>('idle');
  const connectPollIntervalRef = React.useRef<number | null>(null);
  const connectPollTimeoutRef = React.useRef<number | null>(null);
  const lastTrackedAddressRef = React.useRef<string | null>(null);
  const aoTokens = React.useMemo(
    () => profileTokens.filter((item) => item.kind === 'ao-token'),
    [profileTokens]
  );
  const atomicAssets = React.useMemo(
    () => profileTokens.filter((item) => item.kind === 'atomic-asset'),
    [profileTokens]
  );

  const cachedProfileId = React.useMemo(() => {
    if (!address || typeof window === 'undefined') return '';
    return localStorage.getItem(`streamvault:lastProfileId:${address.toLowerCase()}`) || '';
  }, [address]);

  const normalizedProfile = React.useMemo(() => {
    if (!profile) return null;
    const storeRaw = profile?.store || profile?.Store || null;
    const store = libs?.mapFromProcessCase ? libs.mapFromProcessCase(storeRaw || {}) : storeRaw || {};
    return { ...profile, ...store };
  }, [profile, libs]);

  const profileAvatar = React.useMemo(() => {
    const url = getProfileAvatar(normalizedProfile);
    if (url) return url;
    const raw = normalizedProfile?.thumbnail || normalizedProfile?.avatar || normalizedProfile?.image || null;
    return resolveProfileImage(raw);
  }, [normalizedProfile]);

  const profileHref = React.useMemo(() => {
    if (normalizedProfile?.id) return `/profile/${String(normalizedProfile.id)}`;
    if (cachedProfileId) return `/profile/${cachedProfileId}`;
    if (address) return `/profile/${address}`;
    return '/';
  }, [address, cachedProfileId, normalizedProfile?.id]);

  React.useEffect(() => {
    if (address) {
      setConnectError(null);
      setConnectStage('connected');
      if (lastTrackedAddressRef.current !== address) {
        trackEvent('wallet_connected_ui', {
          wallet_type: walletType || 'unknown',
          address_prefix: `${address.slice(0, 6)}...${address.slice(-4)}`,
        });
        lastTrackedAddressRef.current = address;
      }
      window.setTimeout(() => setConnectStage('idle'), 1200);
    } else {
      lastTrackedAddressRef.current = null;
    }
  }, [address, walletType]);

  const clearAddressPolling = React.useCallback(() => {
    if (connectPollIntervalRef.current != null) {
      window.clearInterval(connectPollIntervalRef.current);
      connectPollIntervalRef.current = null;
    }
    if (connectPollTimeoutRef.current != null) {
      window.clearTimeout(connectPollTimeoutRef.current);
      connectPollTimeoutRef.current = null;
    }
  }, []);

  const beginAddressPolling = React.useCallback((wallet: any, timeoutMs = 120000) => {
    clearAddressPolling();
    connectPollIntervalRef.current = window.setInterval(async () => {
      const addr = await wallet?.getActiveAddress?.().catch(() => null);
      if (!addr) return;
      clearAddressPolling();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('arweaveWalletLoaded', { detail: { permissions: ARWEAVE_PERMISSIONS } })
        );
      }
      setConnectStage('connected');
      setShowWalletMenu(false);
      setShowWanderConnectModal(false);
      setStartingWanderConnect(false);
    }, 900);
    connectPollTimeoutRef.current = window.setTimeout(() => {
      clearAddressPolling();
      setStartingWanderConnect(false);
      setConnectStage('awaiting_user');
      setConnectError(null);
    }, timeoutMs);
  }, [clearAddressPolling]);

  React.useEffect(() => {
    return () => {
      clearAddressPolling();
    };
  }, [clearAddressPolling]);

  React.useEffect(() => {
    setMobileNavOpen(false);
  }, [address]);

  React.useEffect(() => {
    if (!isReady || !libs || !address) {
      setProfile(null);
      return;
    }
    try {
      const raw = localStorage.getItem(getProfileSnapshotKey(address));
      if (raw) {
        const cached = JSON.parse(raw);
        if (cached?.id) setProfile(cached);
      }
    } catch {
      // ignore snapshot parse errors
    }
    let cancelled = false;
    (async () => {
      setProfileLoading(true);
      try {
        const overrideId = getStoredProfileOverrideId(address);
        let loaded: any = null;
        if (overrideId && libs.getProfileById) {
          loaded = await libs.getProfileById(overrideId);
          if (!loaded?.id) {
            loaded = null;
            clearStoredProfileOverrideId(address);
          }
        }
        if (!loaded) {
          loaded = await getSelectedOrLatestProfileByWallet(libs, address);
        }
        if (!cancelled) {
          const next = loaded || { id: null };
          setProfile(next);
          if (next?.id) {
            try {
              localStorage.setItem(getProfileSnapshotKey(address), JSON.stringify(next));
            } catch {
              // ignore storage failures
            }
          }
        }
      } catch {
        if (!cancelled) {
          setProfile(null);
        }
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, isReady, libs]);

  React.useEffect(() => {
    const onProfileUpdated = (event: Event) => {
      const custom = event as CustomEvent<{ address?: string; profile?: any }>;
      const nextAddress = custom.detail?.address;
      const nextProfile = custom.detail?.profile;
      if (!address || !nextAddress || address.toLowerCase() !== nextAddress.toLowerCase()) return;
      if (!nextProfile) return;
      setProfile(nextProfile);
      try {
        localStorage.setItem(getProfileSnapshotKey(address), JSON.stringify(nextProfile));
      } catch {
        // ignore storage failures
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('streamvault:profile-updated', onProfileUpdated as EventListener);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('streamvault:profile-updated', onProfileUpdated as EventListener);
      }
    };
  }, [address]);

  React.useEffect(() => {
    if (!address || !normalizedProfile?.id || typeof window === 'undefined') return;
    localStorage.setItem(`streamvault:lastProfileId:${address.toLowerCase()}`, String(normalizedProfile.id));
  }, [address, normalizedProfile?.id]);

  React.useEffect(() => {
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

  React.useEffect(() => {
    setUserProperties({
      profile_connected: Boolean(normalizedProfile?.id),
      profile_id_prefix: normalizedProfile?.id ? `${String(normalizedProfile.id).slice(0, 10)}...` : 'none',
      profile_handle: getProfileHandle(normalizedProfile) || 'none',
      profile_has_avatar: Boolean(profileAvatar),
      profile_ao_token_count: aoTokens.length,
      profile_atomic_asset_count: atomicAssets.length,
    });
  }, [aoTokens.length, atomicAssets.length, normalizedProfile, profileAvatar]);

  const copyText = React.useCallback(async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      trackEvent('copy_value', {
        copy_type: key,
      });
      window.setTimeout(() => setCopiedKey(null), 1400);
    } catch {
      // ignore clipboard failures
    }
  }, []);

  const openAudiusLogin = React.useCallback(() => {
    if (typeof window === 'undefined') return;
    window.open('https://audius.co/login', '_blank', 'noopener,noreferrer');
  }, []);

  const handleConnect = React.useCallback(async (type: 'arweave' | 'ethereum' | 'solana') => {
    try {
      trackEvent('wallet_connect_attempt', { wallet_type: type, source: 'wallet_menu' });
      setConnectError(null);
      await connect(type);
      setShowWalletMenu(false);
      setShowWanderConnectModal(false);
    } catch (e: any) {
      const message = String(e?.message || 'Wallet connection failed.');
      const code = String(e?.code || '');
      if (type === 'arweave' && (
        code === 'ARWEAVE_WALLET_MISSING' ||
        message.toLowerCase().includes('wander wallet not detected') ||
        message.toLowerCase().includes('not available')
      )) {
        trackEvent('wallet_connect_requires_wander_connect', { wallet_type: 'arweave' });
        setShowWanderConnectModal(true);
        return;
      }
      trackEvent('wallet_connect_ui_error', {
        wallet_type: type,
        reason: message.slice(0, 200),
      });
      setConnectError(message);
    }
  }, [connect]);

  const handleUseWanderConnect = React.useCallback(async () => {
    trackEvent('wander_connect_attempt', {
      source: showWanderConnectModal ? 'wander_modal' : 'wallet_menu',
    });
    setStartingWanderConnect(true);
    setConnectError(null);
    setConnectStage('initializing');
    try {
      await Promise.race([
        ensureWanderConnect({
          clientId: (import.meta as any).env?.VITE_WANDER_CONNECT_CLIENT_ID || 'FREE_TRIAL',
          timeoutMs: 12000,
        }),
        new Promise((_, reject) =>
          window.setTimeout(
            () => reject(new Error('Wander Connect initialization timed out.')),
            14000
          )
        ),
      ]);
      setConnectStage('opening');
      trackEvent('wander_connect_window_opened');
      openWanderConnect();
      const wallet = (typeof window !== 'undefined' ? (window as any).arweaveWallet : null);
      if (!wallet?.connect || !wallet?.getActiveAddress) {
        trackEvent('wander_connect_wallet_unavailable');
        throw new Error('Wander Connect is not available yet. Complete authentication and try again.');
      }

      // Start waiting for address immediately and do connect request in background.
      setConnectStage('requesting');
      trackEvent('wander_connect_requesting_permissions');
      beginAddressPolling(wallet, 120000);
      const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
      // Proactively prompt permission/sign flow (and retry once) so first-time users do not need a second click.
      (async () => {
        for (const delayMs of [0, 2500]) {
          if (delayMs) await sleep(delayMs);
          const addr = await wallet.getActiveAddress?.().catch(() => null);
          if (addr) return;
          await Promise.race([
            wallet.connect(ARWEAVE_PERMISSIONS).catch(() => null),
            sleep(8000),
          ]);
        }
      })().catch(() => null);
      setConnectStage('awaiting_user');
      trackEvent('wander_connect_waiting_for_user');
    } catch (e: any) {
      const message = String(e?.message || 'Unable to start Wander Connect.');
      setConnectStage('error');
      setConnectError(message);
      trackEvent('wander_connect_failed', {
        reason: message.slice(0, 200),
      });
    } finally {
      // Only "startup" phase is blocking; after this, polling runs in background.
      setStartingWanderConnect(false);
    }
  }, [beginAddressPolling]);

  const walletMenuContent = address ? (
    <>
      <span className={styles.walletMenuType}>{walletType}</span>
      {profileLoading && <span className={styles.walletMenuType}>Loading profile…</span>}
      {connectError && <span className={styles.walletMenuError}>{connectError}</span>}
      {normalizedProfile?.id && (
        <div className={styles.walletMenuSection}>
          <span className={styles.walletMenuType}>
            {normalizedProfile.displayName || normalizedProfile.username || 'Permaweb profile'}
          </span>
          <span className={styles.walletMenuType}>{String(normalizedProfile.id).slice(0, 14)}…</span>
        </div>
      )}
      <Link
        to={profileHref}
        className={styles.walletMenuAction}
        onClick={() => setShowWalletMenu(false)}
      >
        Open profile
      </Link>
      <button
        type="button"
        className={styles.walletMenuAction}
        onClick={() => copyText(address, 'wallet')}
      >
        {copiedKey === 'wallet' ? 'Copied wallet' : 'Copy wallet address'}
      </button>
      {normalizedProfile?.id && (
        <button
          type="button"
          className={styles.walletMenuAction}
          onClick={() => copyText(String(normalizedProfile.id), 'profile')}
        >
          {copiedKey === 'profile' ? 'Copied profile id' : 'Copy profile id'}
        </button>
      )}
      {aoTokens.length > 0 && (
        <div className={styles.walletMenuSection}>
          <span className={styles.walletMenuType}>AO tokens</span>
          {aoTokens.slice(0, 4).map((token) => (
            <button
              key={token.id}
              type="button"
              className={styles.walletMenuAction}
              onClick={() => copyText(token.id, `token:${token.id}`)}
              title={`kind=${token.kind} source=${token.debug.infoSource}${token.debug.assetType ? ` assetType=${token.debug.assetType}` : ''}`}
            >
              {token.ticker || token.name} · {token.displayBalance}
            </button>
          ))}
        </div>
      )}
      {atomicAssets.length > 0 && (
        <div className={styles.walletMenuSection}>
          <span className={styles.walletMenuType}>Digital assets</span>
          {atomicAssets.slice(0, 4).map((asset) => (
            <button
              key={asset.id}
              type="button"
              className={styles.walletMenuAction}
              onClick={() => copyText(asset.id, `asset:${asset.id}`)}
              title={`kind=${asset.kind} source=${asset.debug.infoSource}${asset.debug.assetType ? ` assetType=${asset.debug.assetType}` : ''}`}
            >
              {asset.name}
            </button>
          ))}
        </div>
      )}
      <div className={styles.walletMenuSection}>
        <span className={styles.walletMenuType}>Audius</span>
        {!apiKeyConfigured ? (
          <span className={styles.walletMenuType}>Missing API key</span>
        ) : audiusUser ? (
          <>
            <span className={styles.walletMenuType}>@{audiusUser.handle}</span>
            <button
              type="button"
              className={styles.walletMenuAction}
              onClick={() => logout()}
            >
              Disconnect Audius
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles.walletMenuAction}
              onClick={openAudiusLogin}
            >
              Open Audius first
            </button>
            <button
              type="button"
              className={styles.walletMenuAction}
              disabled={isLoggingIn}
              onClick={() => login()}
            >
              {isLoggingIn ? 'Connecting Audius…' : 'Connect Audius'}
            </button>
            <span className={styles.walletMenuType}>
              Use email/social in Audius first if prompted for wallet verification.
            </span>
          </>
        )}
        {authError && <span className={styles.walletMenuError}>{authError}</span>}
      </div>
      <button
        type="button"
        className={styles.walletMenuAction}
        onClick={() => {
          disconnect();
          setShowWalletMenu(false);
        }}
      >
        Disconnect
      </button>
    </>
  ) : (
    <>
      {connectError && <span className={styles.walletMenuError}>{connectError}</span>}
      {connectStage !== 'idle' && (
        <span className={styles.walletMenuStatus}>{connectStageText(connectStage)}</span>
      )}
      <div onClickCapture={() => trackEvent('wallet_connect_attempt', { wallet_type: 'arweave_wallet_kit', source: 'wallet_menu' })}>
        <ConnectButton
          className={styles.walletMenuAction}
          style={{
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
          }}
          showBalance={false}
          showProfilePicture={false}
          profileModal={false}
        >
          Arweave (Wallet Kit)
        </ConnectButton>
      </div>
      <button
        type="button"
        className={styles.walletMenuAction}
        onClick={handleUseWanderConnect}
        disabled={startingWanderConnect || isConnecting}
      >
        {startingWanderConnect ? 'Working…' : 'Use Wander Connect (email/social)'}
      </button>
      <button type="button" className={styles.walletMenuAction} onClick={() => handleConnect('ethereum')}>
        Ethereum
      </button>
      <button type="button" className={styles.walletMenuAction} onClick={() => handleConnect('solana')}>
        Solana
      </button>
    </>
  );

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <button
            type="button"
            className={styles.mobileMenuToggle}
            aria-label={mobileNavOpen ? 'Close navigation menu' : 'Open navigation menu'}
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <span className={styles.mobileMenuBar} />
            <span className={styles.mobileMenuBar} />
            <span className={styles.mobileMenuBar} />
          </button>
          <Link to="/" className={styles.logo}>
            <img
              src="/streamvault-logo.png"
              alt="StreamVault"
              className={styles.logoMark}
            />
            <div className={styles.logoTextGroup}>
              <span className={styles.logoText}>StreamVault</span>
              <span className={styles.tagline}>Stream anywhere. Preserve forever.</span>
            </div>
          </Link>
          <nav className={`${styles.nav} ${mobileNavOpen ? styles.navOpen : ''}`}>
            <div className={styles.mobileAccount}>
              {address ? (
                <>
                  <div className={styles.mobileAccountIdentity}>
                    {profileAvatar ? (
                      <img src={profileAvatar} alt="" className={styles.mobileAccountAvatar} />
                    ) : (
                      <span className={styles.mobileAccountAvatarFallback} aria-hidden>
                        {address.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <div className={styles.mobileAccountMeta}>
                      <span className={styles.mobileAccountTitle}>
                        {normalizedProfile?.displayName || normalizedProfile?.username || 'Profile'}
                      </span>
                      <span className={styles.mobileAccountSub}>
                        {address.slice(0, 6)}…{address.slice(-4)}
                      </span>
                    </div>
                  </div>
                  <div className={styles.mobileAccountActions}>
                    <button
                      type="button"
                      className={`${styles.navLink} ${styles.navActionInline}`}
                      onClick={() => setShowWalletMenu((open) => !open)}
                    >
                      Account
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className={`${styles.navLink} ${styles.navActionInline}`}
                  onClick={() => setShowWalletMenu((open) => !open)}
                >
                  Connect wallet
                </button>
              )}
              {showWalletMenu && (
                <div className={`${styles.walletMenu} ${styles.mobileWalletMenu} glass-strong`}>
                  {walletMenuContent}
                </div>
              )}
            </div>
            <Link to="/" className={styles.navLink} onClick={() => setMobileNavOpen(false)}>Discover</Link>
            <Link to="/vault" className={styles.navLink} onClick={() => setMobileNavOpen(false)}>Vault</Link>
            <Link to="/creator-tools" className={styles.navLink} onClick={() => setMobileNavOpen(false)}>Creator tools</Link>
            {address && (
              <Link to={profileHref} className={styles.navLink} onClick={() => setMobileNavOpen(false)}>Profile</Link>
            )}
            <button
              type="button"
              className={`${styles.navLink} ${styles.navAction}`}
              onClick={() => {
                setMobileNavOpen(false);
                setIsPublishOpen(true);
              }}
            >
              Upload
            </button>
          </nav>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={`${styles.walletBtn} ${styles.headerUploadBtn}`}
              onClick={() => setIsPublishOpen(true)}
              style={{ padding: '0 12px', background: 'var(--accent-color)' }}
            >
              Upload
            </button>
            <div className={styles.walletWrap}>
              <button
                type="button"
                className={`${styles.walletBtn} ${address ? styles.walletAvatarBtn : ''}`}
                onClick={() => {
                  const next = !showWalletMenu;
                  setShowWalletMenu(next);
                  trackEvent('wallet_menu_toggle', {
                    open: next,
                    has_connected_wallet: Boolean(address),
                  });
                }}
                disabled={isConnecting}
              >
                {isConnecting
                  ? 'Connecting…'
                  : address ? (
                    <span className={styles.walletBtnContent}>
                      {profileAvatar ? (
                        <img src={profileAvatar} alt="" className={styles.walletAvatar} />
                      ) : (
                        <span className={styles.walletAvatarFallback} aria-hidden>
                          {address.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                    </span>
                  ) : (
                    'Connect wallet'
                  )}
              </button>
              {showWalletMenu && (
                <div className={styles.walletMenu + ' glass-strong'}>
                  {walletMenuContent}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      <main className={styles.main}>{children}</main>

      {isPublishOpen && typeof document !== 'undefined'
        ? createPortal(
          <PublishModal
            onClose={() => setIsPublishOpen(false)}
            onSuccess={() => setIsPublishOpen(false)}
          />,
          document.body
        )
        : null}

      <WanderConnectModal
        open={showWanderConnectModal}
        busy={startingWanderConnect || isConnecting}
        error={connectError}
        onClose={() => setShowWanderConnectModal(false)}
        onUseWanderConnect={handleUseWanderConnect}
      />
    </div>
  );
}
