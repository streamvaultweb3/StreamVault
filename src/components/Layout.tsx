import React from 'react';
import { Link } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { useAudiusAuth } from '../context/AudiusAuthContext';
import { usePermaweb } from '../context/PermawebContext';
import {
  clearStoredProfileOverrideId,
  getProfileAvatar,
  getProfileDisplayName,
  getProfileHandle,
  getSelectedOrLatestProfileByWallet,
  getStoredProfileOverrideId,
} from '../lib/permaProfile';
import { resolveProfileTokens, type ResolvedProfileToken } from '../lib/profileTokens';
import { createPortal } from 'react-dom';
import { PublishModal } from './PublishModal';
import styles from './Layout.module.css';

function resolveProfileImage(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.startsWith('http') || raw.startsWith('data:')) return raw;
  return `https://arweave.net/${raw}`;
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { walletType, address, connect, disconnect, isConnecting } = useWallet();
  const { libs, isReady } = usePermaweb();
  const { audiusUser, login, logout, apiKeyConfigured } = useAudiusAuth();
  const [showWalletMenu, setShowWalletMenu] = React.useState(false);
  const [showAudiusMenu, setShowAudiusMenu] = React.useState(false);
  const [isPublishOpen, setIsPublishOpen] = React.useState(false);
  const [profileLoading, setProfileLoading] = React.useState(false);
  const [profile, setProfile] = React.useState<any | null>(null);
  const [profileTokens, setProfileTokens] = React.useState<ResolvedProfileToken[]>([]);
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const aoTokens = React.useMemo(
    () => profileTokens.filter((item) => item.kind === 'ao-token'),
    [profileTokens]
  );
  const atomicAssets = React.useMemo(
    () => profileTokens.filter((item) => item.kind === 'atomic-asset'),
    [profileTokens]
  );

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

  const walletDisplay = React.useMemo(() => {
    if (!address) return 'Connect wallet';
    const profileLabel = getProfileDisplayName(normalizedProfile) || getProfileHandle(normalizedProfile) || normalizedProfile?.audiusHandle || null;
    return profileLabel || `${address.slice(0, 6)}…${address.slice(-4)}`;
  }, [address, normalizedProfile]);

  React.useEffect(() => {
    if (!isReady || !libs || !address || walletType !== 'arweave') {
      setProfile(null);
      return;
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
        if (!cancelled) setProfile(loaded || { id: null });
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
  }, [address, isReady, libs, walletType]);

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

  const copyText = React.useCallback(async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 1400);
    } catch {
      // ignore clipboard failures
    }
  }, []);

  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
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
          <nav className={styles.nav}>
            <Link to="/" className={styles.navLink}>Discover</Link>
            <Link to="/vault" className={styles.navLink}>StreamVault</Link>
            <Link to="/creator-tools" className={styles.navLink}>Creator tools</Link>
            {address && (
              <Link to={`/profile/${address}`} className={styles.navLink}>Profile</Link>
            )}
            {apiKeyConfigured && (
              <div className={styles.walletWrap}>
                {audiusUser ? (
                  <>
                    <button
                      type="button"
                      className={styles.walletBtn}
                      onClick={() => setShowAudiusMenu(!showAudiusMenu)}
                    >
                      @{audiusUser.handle}
                    </button>
                    {showAudiusMenu && (
                      <div className={styles.walletMenu + ' glass-strong'}>
                        <span className={styles.walletMenuType}>Audius</span>
                        <button type="button" className={styles.walletMenuAction} onClick={() => { logout(); setShowAudiusMenu(false); }}>
                          Log out
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <button type="button" className={styles.audiusLoginBtn} onClick={login}>
                    Log in with Audius
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              className={styles.walletBtn}
              onClick={() => setIsPublishOpen(true)}
              style={{ padding: '0 12px', background: 'var(--accent-color)' }}
            >
              Upload
            </button>
            <div className={styles.walletWrap}>
              <button
                type="button"
                className={styles.walletBtn}
                onClick={() => setShowWalletMenu(!showWalletMenu)}
                disabled={isConnecting}
              >
                {isConnecting
                  ? 'Connecting…'
                  : address ? (
                    <span className={styles.walletBtnContent}>
                      {profileAvatar ? <img src={profileAvatar} alt="" className={styles.walletAvatar} /> : null}
                      <span className={styles.walletBtnLabel}>{walletDisplay}</span>
                    </span>
                  ) : (
                    'Connect wallet'
                  )}
              </button>
              {showWalletMenu && (
                <div className={styles.walletMenu + ' glass-strong'}>
                  {address ? (
                    <>
                      <span className={styles.walletMenuType}>{walletType}</span>
                      {profileLoading && <span className={styles.walletMenuType}>Loading profile…</span>}
                      {normalizedProfile?.id && (
                        <div className={styles.walletMenuSection}>
                          <span className={styles.walletMenuType}>
                            {normalizedProfile.displayName || normalizedProfile.username || 'Permaweb profile'}
                          </span>
                          <span className={styles.walletMenuType}>{String(normalizedProfile.id).slice(0, 14)}…</span>
                        </div>
                      )}
                      <Link
                        to={`/profile/${address}`}
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
                      <button type="button" className={styles.walletMenuAction} onClick={() => { disconnect(); setShowWalletMenu(false); }}>
                        Disconnect
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className={styles.walletMenuAction} onClick={() => { connect('arweave'); setShowWalletMenu(false); }}>
                        Arweave (Wander)
                      </button>
                      <button type="button" className={styles.walletMenuAction} onClick={() => { connect('ethereum'); setShowWalletMenu(false); }}>
                        Ethereum
                      </button>
                      <button type="button" className={styles.walletMenuAction} onClick={() => { connect('solana'); setShowWalletMenu(false); }}>
                        Solana
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </nav>
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
    </div>
  );
}
