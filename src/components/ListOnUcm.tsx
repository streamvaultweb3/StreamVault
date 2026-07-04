import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '../context/WalletContext';
import { usePermaweb } from '../context/PermawebContext';
import { getSelectedOrLatestProfileByWallet, getStoredProfileOverrideId, collectProfileAssetRefs, isLegacyIndexedProfile } from '../lib/permaProfile';
import {
  bazarAssetUrl,
  cancelUcmListing,
  fetchSellerAssetBalance,
  listMusicAssetOnUcm,
  ucmConfigured,
  type UcmListingStatus,
} from '../lib/ucm';
import {
  getCachedAssetOrderbookId,
  extractOrderbookIdFromUcmMessage,
  markOrderbookSpawnedForAsset,
  rememberAssetOrderbookId,
} from '../lib/ucmOrderbookCache';
import {
  getDefaultUcmQuoteToken,
} from '../lib/ucmTokens';
import { fetchWalletListingsForAsset, type UcmActiveOrder } from '../lib/ucmMarketplace';
import { resolveCanonicalAtomicAssetId } from '../lib/ucmAssetResolve';
import styles from './ListOnUcm.module.css';
import { UcmMarketProcesses } from './UcmMarketProcesses';

export type ListOnUcmProps = {
  assetId: string;
  title?: string;
  /** Pre-fill listing price (AR). */
  defaultPriceAr?: string;
  /** Pre-fill quantity; capped by wallet balance when known. */
  defaultQuantity?: number;
  /** Hide quantity field and list 1 copy. */
  singleCopy?: boolean;
  /** Compact layout for track detail / inline panels. */
  compact?: boolean;
  className?: string;
};

export function ListOnUcm({
  assetId,
  title,
  defaultPriceAr = '0.1',
  defaultQuantity = 1,
  singleCopy = false,
  compact = false,
  className,
}: ListOnUcmProps) {
  const { address, walletType, connect } = useWallet();
  const { libs } = usePermaweb();
  const [profileId, setProfileId] = useState<string | null>(null);
  const [isLegacyProfile, setIsLegacyProfile] = useState(false);
  const [profileHasAsset, setProfileHasAsset] = useState(false);
  const [priceAr, setPriceAr] = useState(defaultPriceAr);
  const [quantity, setQuantity] = useState(String(defaultQuantity));
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceInferred, setBalanceInferred] = useState(false);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [status, setStatus] = useState<UcmListingStatus | null>(null);
  const [isListing, setIsListing] = useState(false);
  const [activeOrders, setActiveOrders] = useState<UcmActiveOrder[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersTimedOut, setOrdersTimedOut] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [marketRefreshKey, setMarketRefreshKey] = useState(0);
  const [knownOrderbookId, setKnownOrderbookId] = useState<string | null>(() =>
    getCachedAssetOrderbookId(assetId)
  );
  const [ucmAssetId, setUcmAssetId] = useState(assetId);
  const selectedQuoteToken = useMemo(() => getDefaultUcmQuoteToken(), []);

  useEffect(() => {
    let cancelled = false;
    void resolveCanonicalAtomicAssetId(assetId).then((id) => {
      if (!cancelled) setUcmAssetId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [assetId]);

  const refreshDedicatedOrderbook = useCallback(async () => {
    setMarketRefreshKey((k) => k + 1);
  }, []);

  const refreshActiveOrders = useCallback(async () => {
    if (!ucmAssetId || !address || walletType !== 'arweave') {
      setActiveOrders([]);
      return;
    }
    setOrdersLoading(true);
    setOrdersTimedOut(false);
    try {
      const { orders, timedOut } = await fetchWalletListingsForAsset({
        assetId: ucmAssetId,
        walletAddress: address,
        profileId,
        quoteTokenId: selectedQuoteToken.id,
        orderbookIdHint: knownOrderbookId,
      });
      setActiveOrders(orders);
      setOrdersTimedOut(Boolean(timedOut));
      setMarketRefreshKey((k) => k + 1);
    } catch {
      setActiveOrders([]);
      setOrdersTimedOut(false);
    } finally {
      setOrdersLoading(false);
    }
  }, [address, knownOrderbookId, ucmAssetId, profileId, selectedQuoteToken.id, walletType]);

  useEffect(() => {
    let cancelled = false;
    if (!libs || !address || walletType !== 'arweave') {
      setProfileId(null);
      return;
    }
    void getSelectedOrLatestProfileByWallet(libs, address, { useOverride: true })
      .then((profile) => {
        const overrideId = getStoredProfileOverrideId(address);
        const id = overrideId || profile?.id || null;
        if (!cancelled) {
          setProfileId(id);
          setIsLegacyProfile(isLegacyIndexedProfile(profile));
          setProfileHasAsset(
            Boolean(id && collectProfileAssetRefs(profile).some((row) => row.id === ucmAssetId || row.id === assetId))
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProfileId(null);
          setIsLegacyProfile(false);
          setProfileHasAsset(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [address, assetId, ucmAssetId, libs, walletType]);

  useEffect(() => {
    setKnownOrderbookId(getCachedAssetOrderbookId(ucmAssetId) || getCachedAssetOrderbookId(assetId));
  }, [assetId, ucmAssetId]);

  useEffect(() => {
    setPriceAr(defaultPriceAr);
  }, [defaultPriceAr]);

  useEffect(() => {
    setQuantity(String(defaultQuantity));
  }, [defaultQuantity]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const refreshBalance = async () => {
      if (!ucmAssetId || !address || walletType !== 'arweave') {
        setBalance(null);
        setBalanceInferred(false);
        setBalanceLoading(false);
        return;
      }
      setBalanceLoading(true);
      const result = await fetchSellerAssetBalance({
        assetId: ucmAssetId,
        walletAddress: address,
        profileId,
      }).catch(() => ({
        copies: 0,
        inferredFromCreator: false,
      }));
      if (cancelled) return;
      setBalance(result.copies);
      setBalanceInferred(result.inferredFromCreator);
      setBalanceLoading(false);
    };

    void refreshBalance();

    pollTimer = setInterval(() => {
      if (cancelled) return;
      void refreshBalance();
    }, 30000);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [address, ucmAssetId, profileId, selectedQuoteToken.id, walletType]);

  useEffect(() => {
    void refreshDedicatedOrderbook();
  }, [refreshDedicatedOrderbook]);

  useEffect(() => {
    void refreshActiveOrders();
  }, [refreshActiveOrders]);

  const handleCancel = useCallback(
    async (order: UcmActiveOrder) => {
      if (!address) return;
      setCancellingId(order.orderId);
      setStatus(null);
      try {
        await cancelUcmListing({
          orderbookId: order.orderbookId,
          orderId: order.orderId,
          assetId: order.assetId,
          quoteToken: order.quoteToken,
          profileId,
          walletAddress: address,
          onStatus: setStatus,
        });
        await refreshActiveOrders();
        const bal = await fetchSellerAssetBalance({ assetId, walletAddress: address, profileId }).catch(() => ({
          copies: 0,
          inferredFromCreator: false,
        }));
        setBalance(bal.copies);
        setBalanceInferred(bal.inferredFromCreator);
        window.dispatchEvent(new Event('streamvault:marketplace-updated'));
      } catch (e: any) {
        setStatus({
          processing: false,
          success: false,
          message: e?.message || 'Failed to cancel listing.',
        });
      } finally {
        setCancellingId(null);
      }
    },
    [address, assetId, profileId, refreshActiveOrders]
  );

  const maxQty = useMemo(() => {
    if (balance == null) return null;
    return Math.max(0, balance);
  }, [balance]);

  const showQuantityField = !singleCopy && (maxQty == null || maxQty > 1);

  const parsedQuantity = useMemo(() => {
    const requested = Math.max(1, parseInt(quantity, 10) || 1);
    if (singleCopy) return 1;
    if (maxQty != null && maxQty > 0) return Math.min(requested, maxQty);
    return requested;
  }, [maxQty, quantity, singleCopy]);

  useEffect(() => {
    if (singleCopy || maxQty == null || maxQty <= 0) return;
    setQuantity((prev) => {
      const n = Math.max(1, parseInt(prev, 10) || 1);
      const capped = Math.min(n, maxQty);
      return String(capped);
    });
  }, [maxQty, singleCopy]);

  const canList = ucmConfigured() && walletType === 'arweave' && Boolean(address);

  const handleList = useCallback(async () => {
    if (!assetId) return;
    if (walletType !== 'arweave' || !address) {
      await connect('arweave');
      return;
    }
    setStatus(null);
    setIsListing(true);
    setStatus({
      processing: true,
      success: false,
      message: 'Starting UCM listing — Wander will prompt you to sign shortly…',
    });
    try {
      const qty = parsedQuantity;
      if (maxQty != null && maxQty <= 0) {
        throw new Error(
          'No confirmed copies on your wallet or profile zone. Transfer a copy to your wallet before listing.'
        );
      }
      const result = await listMusicAssetOnUcm({
        assetId: ucmAssetId,
        walletAddress: address,
        profileId,
        profileHasAsset,
        isLegacyProfile,
        quantity: qty,
        priceQuote: priceAr,
        quoteTokenId: selectedQuoteToken.id,
        onStatus: setStatus,
      });
      setKnownOrderbookId(result.orderbookId);
      rememberAssetOrderbookId(ucmAssetId, result.orderbookId);
      for (let i = 0; i < 5; i++) {
        await refreshActiveOrders();
        if (i < 4) await new Promise((r) => setTimeout(r, 2000));
      }
      await refreshDedicatedOrderbook();
      window.dispatchEvent(new Event('streamvault:marketplace-updated'));
    } catch (e: any) {
      let confirmedRows: UcmActiveOrder[] = [];
      if (address && walletType === 'arweave') {
        try {
          const { orders } = await fetchWalletListingsForAsset({
            assetId: ucmAssetId,
            walletAddress: address,
            profileId,
            quoteTokenId: selectedQuoteToken.id,
            orderbookIdHint: knownOrderbookId,
          });
          confirmedRows = orders;
          setActiveOrders(confirmedRows);
        } catch {
          await refreshActiveOrders();
        }
      } else {
        await refreshActiveOrders();
      }
      await refreshDedicatedOrderbook();
      if (confirmedRows.length > 0) {
        setStatus({
          processing: false,
          success: true,
          message:
            `Listed on UCM. Your sell order is active — on Bazar, open this asset and select ${selectedQuoteToken.symbol} as the market token.`,
        });
        window.dispatchEvent(new Event('streamvault:marketplace-updated'));
        return;
      }
      const errMsg = e?.message || 'Failed to list on UCM.';
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.setItem(`streamvault:ucm-last-error:${assetId}`, errMsg);
        } catch {
          // ignore
        }
      }
      const orderbookFromErr = extractOrderbookIdFromUcmMessage(errMsg);
      if (orderbookFromErr) {
        rememberAssetOrderbookId(assetId, orderbookFromErr);
        markOrderbookSpawnedForAsset(assetId, orderbookFromErr);
        setKnownOrderbookId(orderbookFromErr);
        setMarketRefreshKey((k) => k + 1);
      }
      setStatus({
        processing: false,
        success: false,
        message: errMsg,
      });
    } finally {
      setIsListing(false);
    }
  }, [address, assetId, ucmAssetId, connect, isLegacyProfile, maxQty, parsedQuantity, priceAr, profileHasAsset, profileId, refreshActiveOrders, selectedQuoteToken.id, walletType]);

  if (!ucmConfigured()) {
    return (
      <div className={`${styles.panel} ${className || ''}`}>
        <p className={styles.hint}>
          UCM is not configured. Set <code>VITE_AO_UCM_PROCESS</code> and <code>VITE_AO_WAR_TOKEN</code> in your env.
        </p>
      </div>
    );
  }

  return (
    <div className={`${styles.panel} ${compact ? styles.panelCompact : ''} ${className || ''}`}>
      <div className={styles.header}>
        <h3 className={styles.title}>List on UCM</h3>
        {title && !compact ? <p className={styles.subtitle}>{title}</p> : null}
      </div>

      <UcmMarketProcesses
        assetId={ucmAssetId}
        compact
        refreshKey={marketRefreshKey}
        orderbookIdHint={knownOrderbookId}
      />

      {!compact ? (
        <p className={styles.hint}>
          Sell copies on UCM (wAR). First list spawns a dedicated orderbook + activity process for this asset.
        </p>
      ) : null}

      {balanceLoading ? (
        <p className={styles.balance}>Checking balance…</p>
      ) : balance != null ? (
        <p className={styles.balance}>
          Balance: <strong>{balance}</strong>
          {balanceInferred ? <span className={styles.balanceNote}> (syncing)</span> : null}
        </p>
      ) : null}

      <div className={compact ? styles.formRow : undefined}>
        <label className={styles.label}>
          Price ({selectedQuoteToken.symbol})
          <input
            className={styles.input}
            type="number"
            min={0}
            step={0.001}
            value={priceAr}
            onChange={(e) => setPriceAr(e.target.value)}
            disabled={isListing}
          />
        </label>

        {showQuantityField ? (
          <label className={styles.label}>
            Qty
            <input
              className={styles.input}
              type="number"
              min={1}
              max={maxQty ?? undefined}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={isListing}
            />
          </label>
        ) : null}
      </div>

      <button
        type="button"
        className={styles.listBtn}
        disabled={isListing}
        onClick={() => void handleList()}
      >
        {isListing
          ? 'Listing…'
          : canList
            ? parsedQuantity === 1
              ? 'List on UCM'
              : `List ${parsedQuantity} on UCM`
            : 'Connect Wander to list'}
      </button>

      {status?.message ? (
        <p className={status.success ? styles.success : styles.error}>{status.message}</p>
      ) : null}

      <div className={styles.links}>
        <a href={bazarAssetUrl(assetId)} target="_blank" rel="noopener noreferrer">
          Bazar
        </a>
      </div>

      {canList ? (
        <div className={styles.activeSection}>
          <div className={styles.activeHeader}>
            <h4 className={styles.activeTitle}>Your listings</h4>
            <button type="button" className={styles.refreshOrdersBtn} onClick={() => void refreshActiveOrders()}>
              Refresh
            </button>
          </div>
          {ordersLoading ? (
            <p className={styles.hint}>Loading listings…</p>
          ) : activeOrders.length > 0 ? (
            <ul className={styles.activeList}>
              {activeOrders.map((order) => (
                <li key={order.orderId} className={styles.activeItem}>
                  <div>
                    <strong>
                      {order.priceDisplay} {order.quoteSymbol}
                    </strong>
                    <span className={styles.activeQty}> · {order.quantity}</span>
                  </div>
                  <button
                    type="button"
                    className={styles.cancelBtn}
                    disabled={Boolean(cancellingId)}
                    onClick={() => void handleCancel(order)}
                  >
                    {cancellingId === order.orderId ? '…' : 'Cancel'}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.hint}>
              {ordersTimedOut
                ? 'Listing lookup timed out — orderbook or balance reads may still be syncing. Try Refresh.'
                : 'No active listings found. If you listed before, orderbook state may still be syncing — try Refresh.'}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
