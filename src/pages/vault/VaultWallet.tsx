import { useState, useEffect } from 'react';
import { useWallet } from '../../context/WalletContext';
import { ARWEAVE_DATA_GATEWAY_BASE } from '../../lib/arweaveDataGateway';
import styles from './Vault.module.css';

const GATEWAY = ARWEAVE_DATA_GATEWAY_BASE;

export function VaultWallet() {
  const { address, walletType } = useWallet();
  const [arBalance, setArBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) {
      setArBalance(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`${GATEWAY}/wallet/${address}/balance`)
      .then((r) => r.text())
      .then((raw) => {
        if (cancelled) return;
        const winston = raw ? Number(raw) : 0;
        const ar = winston / 1e12;
        setArBalance(ar.toFixed(6));
      })
      .catch(() => {
        if (!cancelled) setArBalance(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [address]);

  if (!address) {
    return (
      <>
        <h1 className={styles.sectionTitle}>Wallet</h1>
        <p className={styles.sectionSubtitle}>Connect a wallet to view balance and address.</p>
        <p className={styles.placeholderBox}>Connect your wallet from the header to see your wallet details here.</p>
      </>
    );
  }

  return (
    <>
      <h1 className={styles.sectionTitle}>Wallet</h1>
      <p className={styles.sectionSubtitle}>Your connected wallet and AR balance.</p>
      <div className={styles.walletCard}>
        <div className={styles.balanceRow}>
          <span className={styles.rewardsKey}>Network</span>
          <span className={styles.rewardsAmount}>{walletType || '—'}</span>
        </div>
        <div className={styles.balanceRow}>
          <span className={styles.rewardsKey}>Address</span>
          <span className={styles.rewardsAmount} style={{ fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>
            {address}
          </span>
        </div>
        <div className={styles.balanceRow}>
          <span className={styles.rewardsKey}>AR balance</span>
          <span className={styles.rewardsAmount}>
            {loading ? '…' : arBalance != null ? `${arBalance} AR` : '—'}
          </span>
        </div>
      </div>
    </>
  );
}
