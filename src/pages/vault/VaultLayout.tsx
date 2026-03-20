import React from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useWallet } from '../../context/WalletContext';
import { useAudiusAuth } from '../../context/AudiusAuthContext';
import { createPortal } from 'react-dom';
import { PublishModal } from '../../components/PublishModal';
import styles from './VaultLayout.module.css';

type IconProps = {
  className?: string;
};

function IconTrending({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4 18L10 12L14 16L20 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 12V8H16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconFeed({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="8" cy="8" r="3" />
      <circle cx="16.5" cy="9" r="2.5" />
      <path d="M3.5 18.5C4.2 15.8 6 14.5 8 14.5C10 14.5 11.8 15.8 12.5 18.5" strokeLinecap="round" />
      <path d="M13.5 18.5C14 16.7 15.2 15.8 16.5 15.8C17.8 15.8 19 16.7 19.5 18.5" strokeLinecap="round" />
    </svg>
  );
}

function IconExplore({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16.5 16.5L20 20" strokeLinecap="round" />
    </svg>
  );
}

function IconLibrary({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M5 5.5H16.5V18.5H5z" />
      <path d="M16.5 7H19V20H7.5V18.5" strokeLinecap="round" />
      <path d="M8 9H13.5" strokeLinecap="round" />
      <path d="M8 12H12.5" strokeLinecap="round" />
    </svg>
  );
}

function IconMessages({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4.5 6.5H19.5V15.5H10L6 19V15.5H4.5z" strokeLinejoin="round" />
      <path d="M8 10H16" strokeLinecap="round" />
      <path d="M8 13H13.5" strokeLinecap="round" />
    </svg>
  );
}

function IconWallet({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4.5 7.5H18.5V18H4.5z" />
      <path d="M18.5 10H21V15H18.5z" />
      <path d="M6.5 7.5L8.5 5.5H19.5V7.5" strokeLinecap="round" />
      <circle cx="19.8" cy="12.5" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconRewards({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4.5 9H19.5V19H4.5z" />
      <path d="M12 9V19" />
      <path d="M4.5 12.5H19.5" />
      <path d="M12 9C10 9 8.8 8.2 8.8 6.9C8.8 5.8 9.7 5 10.9 5C11.6 5 12.2 5.3 12 6.4" strokeLinecap="round" />
      <path d="M12 9C14 9 15.2 8.2 15.2 6.9C15.2 5.8 14.3 5 13.1 5C12.4 5 11.8 5.3 12 6.4" strokeLinecap="round" />
    </svg>
  );
}

function IconPlaylists({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M7 7H19" strokeLinecap="round" />
      <path d="M7 11H19" strokeLinecap="round" />
      <path d="M7 15H15" strokeLinecap="round" />
      <circle cx="5" cy="15.5" r="1.6" />
      <path d="M17 16V8.2L20 7.5V15.3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="20" cy="16.8" r="1.6" />
    </svg>
  );
}

function IconUpload({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M12 5V14" strokeLinecap="round" />
      <path d="M8.5 8.5L12 5L15.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 16.5H19" strokeLinecap="round" />
      <path d="M6 19H18" strokeLinecap="round" />
    </svg>
  );
}

export function VaultLayout() {
  const { address, walletType } = useWallet();
  const { audiusUser, apiKeyConfigured } = useAudiusAuth();
  const [isPublishOpen, setIsPublishOpen] = React.useState(false);

  const openUpload = () => setIsPublishOpen(true);

  const navItems = [
    { to: '/vault', end: true, label: 'Trending', icon: IconTrending },
    { to: '/vault/feed', end: false, label: 'Feed', icon: IconFeed },
    { to: '/vault/explore', end: false, label: 'Explore', icon: IconExplore },
    { to: '/vault/library', end: false, label: 'Library', icon: IconLibrary },
    { to: '/vault/messages', end: false, label: 'Messages', icon: IconMessages },
    { to: '/vault/wallet', end: false, label: 'Wallet', icon: IconWallet },
    { to: '/vault/rewards', end: false, label: 'Rewards', icon: IconRewards },
    { to: '/vault/playlists', end: false, label: 'Playlists', icon: IconPlaylists },
  ];

  return (
    <div className={styles.vaultWrap}>
      <aside className={styles.sidebar}>
        <Link to="/vault" className={styles.sidebarLogo}>
          <span className={styles.sidebarLogoText}>Vault</span>
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
              title={item.label}
              className={({ isActive }) =>
                [styles.sidebarLink, isActive ? styles.sidebarLinkActive : ''].filter(Boolean).join(' ')
              }
            >
              <item.icon className={styles.sidebarIcon} />
              <span className={styles.sidebarLabel}>{item.label}</span>
            </NavLink>
          ))}
          <button
            type="button"
            className={styles.sidebarLink}
            onClick={openUpload}
            style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left' }}
            title="Upload"
          >
            <IconUpload className={styles.sidebarIcon} />
            <span className={styles.sidebarLabel}>Upload</span>
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
