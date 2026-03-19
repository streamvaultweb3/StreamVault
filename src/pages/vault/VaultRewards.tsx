import { useState, useEffect } from 'react';
import { useWallet } from '../../context/WalletContext';
import { getRoyaltyPayoutPlan } from '../../lib/aoRoyaltyEngine';
import styles from './Vault.module.css';

export function VaultRewards() {
  const { address } = useWallet();
  const [balances, setBalances] = useState<{ key: string; amount: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRoyaltyPayoutPlan()
      .then((plan) => {
        if (cancelled) return;
        const rows: { key: string; amount: number }[] = [];
        for (const [k, v] of Object.entries(plan ?? {})) {
          const amount = typeof v === 'number' ? v : Number(v as any);
          if (!Number.isFinite(amount) || amount <= 0) continue;
          if (address && k.endsWith(':' + address)) {
            rows.push({ key: k, amount });
          } else if (!address) {
            rows.push({ key: k, amount });
          }
        }
        setBalances(rows);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message ?? 'Failed to load rewards.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [address]);

  return (
    <>
      <h1 className={styles.sectionTitle}>Rewards</h1>
      <p className={styles.sectionSubtitle}>
        Accrued royalties from the AO Royalty Engine (e.g. $U, MATIC). Payouts are settled off-chain.
      </p>
      {error && <p className={styles.errorText}>{error}</p>}
      {loading ? (
        <p className={styles.loading}>Loading…</p>
      ) : (
        <div className={styles.walletCard}>
          {balances.length === 0 ? (
            <p className={styles.placeholderBox} style={{ margin: 0, padding: 24 }}>
              No accrued balances for your address yet.
            </p>
          ) : (
            balances.map(({ key, amount }) => (
              <div key={key} className={styles.balanceRow}>
                <span className={styles.rewardsKey}>{key}</span>
                <span className={styles.rewardsAmount}>{amount}</span>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
