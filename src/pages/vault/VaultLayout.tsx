import React from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useWallet } from '../../context/WalletContext';
import { useAudiusAuth } from '../../context/AudiusAuthContext';
import { createPortal } from 'react-dom';
import { PublishModal } from '../../components/PublishModal';
import styles from './VaultLayout.module.css';

export function VaultLayout() {
  const { address, walletType } = useWallet();
  const { audiusUser, apiKeyConfigured } = useAudiusAuth();
  const [isPublishOpen, setIsPublishOpen] = React.useState(false);

  const openUpload = () => setIsPublishOpen(true);

  const navItems = [
    { to: '/vault', end: true, label: 'Trending', icon: '📈' },
    { to: '/vault/feed', end: false, label: 'Feed', icon: '👥' },
    { to: '/vault/explore', end: false, label: 'Explore', icon: '🔍' },
    { to: '/vault/library', end: false, label: 'Library', icon: '📚' },
    { to: '/vault/messages', end: false, label: 'Messages', icon: '💬' },
    { to: '/vault/wallet', end: false, label: 'Wallet', icon: '👛' },
    { to: '/vault/rewards', end: false, label: 'Rewards', icon: '🎁' },
    { to: '/vault/playlists', end: false, label: 'Playlists', icon: '♫' },
  ];

  return (
    <div className={styles.vaultWrap}>
      <aside className={styles.sidebar}>
        <Link to="/vault" className={styles.sidebarLogo}>
          <img src="/streamvault-logo.png" alt="" className={styles.sidebarLogoMark} />
          <span className={styles.sidebarLogoText}>StreamVault</span>
        </Link>
        <div className={styles.sidebarUser}>
          {address ? (
            <>
              <div className={styles.sidebarUserAddress}>
                {walletType} · {address.slice(0, 8)}…{address.slice(-6)}
              </div>
              {apiKeyConfigured && audiusUser && (
                <div className={styles.sidebarUserAddress}>@{audiusUser.handle}</div>
              )}
            </>
          ) : (
            <div className={styles.sidebarUserAddress}>Connect wallet</div>
          )}
        </div>
        <nav className={styles.sidebarNav}>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                [styles.sidebarLink, isActive ? styles.sidebarLinkActive : ''].filter(Boolean).join(' ')
              }
            >
              <span className={styles.sidebarIcon} aria-hidden>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
          <button
            type="button"
            className={styles.sidebarLink}
            onClick={openUpload}
            style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}
          >
            <span className={styles.sidebarIcon} aria-hidden>⬆️</span>
            Upload
          </button>
        </nav>
      </aside>
      <main className={styles.content}>
        <Outlet />
      </main>

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
