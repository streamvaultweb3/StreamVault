import { useCallback, useEffect, useState } from 'react';
import { lunarTxExplorerUrl } from '../lib/arweaveDataGateway';
import {
  fetchAssetUcmMarketStatus,
  resolveAssetOrderbookIdFast,
  type AssetUcmMarketStatus,
} from '../lib/ucmMarketplace';
import { discoverUcmProcessesFromGraphql } from '../lib/ucmOrderbookDiscover';
import {
  getCachedAssetOrderbookId,
  extractOrderbookIdFromUcmMessage,
  rememberAssetOrderbookId,
  markOrderbookSpawnedForAsset,
} from '../lib/ucmOrderbookCache';
import styles from './UcmMarketProcesses.module.css';

export type UcmMarketProcessesProps = {
  assetId: string;
  className?: string;
  refreshKey?: number;
  orderbookIdHint?: string | null;
  compact?: boolean;
};

function shortId(id: string): string {
  const s = id.trim();
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}…${s.slice(-6)}`;
}

function ProcessRow(props: {
  label: string;
  processId: string | null | undefined;
  compact?: boolean;
  missingLabel?: string;
}) {
  const id = String(props.processId || '').trim();
  if (!id) {
    return (
      <div className={props.compact ? styles.rowCompact : styles.row}>
        <span className={styles.label}>{props.label}</span>
        <span className={styles.missing}>{props.missingLabel ?? 'Not linked'}</span>
      </div>
    );
  }
  return (
    <div className={props.compact ? styles.rowCompact : styles.row}>
      <span className={styles.label}>{props.label}</span>
      <code className={styles.mono} title={id}>
        {props.compact ? shortId(id) : id}
      </code>
      <div className={styles.links}>
        <a href={lunarTxExplorerUrl(id)} target="_blank" rel="noopener noreferrer">
          Lunar
        </a>
        <button type="button" className={styles.copyBtn} onClick={() => void navigator.clipboard.writeText(id)}>
          Copy
        </button>
      </div>
    </div>
  );
}

export function UcmMarketProcesses({
  assetId,
  className,
  refreshKey = 0,
  orderbookIdHint,
  compact = false,
}: UcmMarketProcessesProps) {
  const resolvedHint =
    String(orderbookIdHint || '').trim() ||
    getCachedAssetOrderbookId(assetId) ||
    (typeof window !== 'undefined'
      ? extractOrderbookIdFromUcmMessage(
          sessionStorage.getItem(`streamvault:ucm-last-error:${assetId}`) || ''
        )
      : null) ||
    null;

  const [status, setStatus] = useState<AssetUcmMarketStatus | null>(null);
  const [fastOrderbookId, setFastOrderbookId] = useState<string | null>(resolvedHint);
  const [fastActivityId, setFastActivityId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!assetId) {
      setStatus(null);
      setFastOrderbookId(null);
      setFastActivityId(null);
      return;
    }
    if (resolvedHint && !getCachedAssetOrderbookId(assetId)) {
      rememberAssetOrderbookId(assetId, resolvedHint);
      markOrderbookSpawnedForAsset(assetId, resolvedHint);
    }
    setLoading(true);
    setDetailLoading(true);
    setError(null);

    try {
      const [obId, disc] = await Promise.all([
        resolveAssetOrderbookIdFast(assetId, resolvedHint),
        discoverUcmProcessesFromGraphql(assetId),
      ]);
      if (obId) setFastOrderbookId(obId);
      if (disc.orderbookId) setFastOrderbookId((prev) => prev || disc.orderbookId);
      if (disc.activityProcessId) setFastActivityId(disc.activityProcessId);
    } finally {
      setLoading(false);
    }

    try {
      const next = await fetchAssetUcmMarketStatus(assetId, {
        orderbookIdHint: resolvedHint,
      });
      setStatus(next);
      if (next.orderbookId) setFastOrderbookId(next.orderbookId);
      if (next.activityProcessId) setFastActivityId(next.activityProcessId);
    } catch (e: any) {
      setError(e?.message || 'Could not load UCM market processes.');
    } finally {
      setDetailLoading(false);
    }
  }, [assetId, resolvedHint]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const onUpdate = () => void load();
    window.addEventListener('streamvault:marketplace-updated', onUpdate);
    return () => window.removeEventListener('streamvault:marketplace-updated', onUpdate);
  }, [load]);

  if (!assetId) return null;

  const displayOrderbookId = status?.orderbookId || fastOrderbookId;
  const displayActivityId = status?.activityProcessId || fastActivityId;
  const activitySyncing =
    Boolean(displayOrderbookId) &&
    !displayActivityId &&
    (detailLoading || (Boolean(status?.orderbookId) && status?.orderbookReachable === false));

  const statusLine = status
    ? [
        status.orderbookSource === 'dedicated' ? 'Dedicated orderbook' : status.orderbookSource,
        status.orderbookDiscoveredViaGraphql ? 'L1 spawn tags' : null,
        status.orderbookIdFromCache ? 'cached id' : null,
        status.metadataOrderbookLinked ? 'Metadata linked' : null,
        status.orderbookReachable ? `${status.totalAskCount} ask(s)` : 'state syncing',
      ]
        .filter(Boolean)
        .join(' · ')
    : displayOrderbookId && detailLoading
      ? 'Orderbook id found · syncing state…'
      : null;

  return (
    <div className={`${styles.panel} ${compact ? styles.panelCompact : ''} ${className || ''}`}>
      <div className={styles.header}>
        <h4 className={styles.title}>{compact ? 'Market processes' : 'UCM market processes'}</h4>
        <button type="button" className={styles.refreshBtn} disabled={loading || detailLoading} onClick={() => void load()}>
          {loading || detailLoading ? '…' : 'Refresh'}
        </button>
      </div>

      {!compact ? (
        <p className={styles.hint}>
          Per-asset micro orderbook (listings land here). Activity process indexes trades for Bazar.
        </p>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={compact ? styles.processGrid : undefined}>
        <ProcessRow compact={compact} label="Orderbook" processId={displayOrderbookId} />
        <ProcessRow
          compact={compact}
          label="Activity"
          processId={displayActivityId}
          missingLabel={activitySyncing ? 'Syncing…' : undefined}
        />
      </div>

      {status && statusLine ? (
        <p className={styles.metaLine}>{statusLine}</p>
      ) : statusLine ? (
        <p className={styles.metaLine}>{statusLine}</p>
      ) : loading && !displayOrderbookId ? (
        <p className={styles.hint}>Loading…</p>
      ) : null}

      {!compact && status?.pairSummaries.length ? (
        <ul className={styles.pairList}>
          {status.pairSummaries.map((pair) => (
            <li key={`${pair.base}:${pair.quote}`}>
              Pair {pair.base.slice(0, 8)}… / {pair.quote.slice(0, 8)}… — {pair.askCount} ask
              {pair.askCount === 1 ? '' : 's'}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
