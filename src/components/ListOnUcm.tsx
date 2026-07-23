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
  rememberAssetListingAttempt,
  rememberAssetOrderbookId,
} from '../lib/ucmOrderbookCache';
import {
  getDefaultUcmQuoteToken,
  getUcmQuoteTokens,
  getUcmQuoteToken,
  rememberPreferredUcmQuoteTokenId,
  resolveInitialUcmQuoteToken,
  tokenDisplayToBaseUnits,
  type UcmQuoteToken,
} from '../lib/ucmTokens';
import {
  fetchWalletListingsForAsset,
  isEscrowedUnreadOrderId,
  type UcmActiveOrder,
} from '../lib/ucmMarketplace';
import { resolveCanonicalAtomicAssetId } from '../lib/ucmAssetResolve';
import styles from './ListOnUcm.module.css';
import { UcmMarketProcesses } from './UcmMarketProcesses';

export type ListOnUcmProps = {
  assetId: string;
  title?: string;
  /** L1 spawn creator / tx owner — gates the panel on track pages. */
  assetCreatorHint?: string | null;
  /** Skip ownership gate (e.g. post-publish success where the publisher is always the owner). */
  assumeOwner?: boolean;
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
  assetCreatorHint,
  assumeOwner = false,
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
  const [balanceWallet, setBalanceWallet] = useState<number | null>(null);
  const [balanceProfile, setBalanceProfile] = useState<number | null>(null);
  const [balanceInferred, setBalanceInferred] = useState(false);
  const [balanceEmptyConfirmed, setBalanceEmptyConfirmed] = useState(false);
  const [balanceEscrowed, setBalanceEscrowed] = useState(0);
  const [balanceUncredited, setBalanceUncredited] = useState(0);
  const [balanceTotalSupply, setBalanceTotalSupply] = useState<number | null>(null);
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
  const quoteTokens = useMemo(() => getUcmQuoteTokens(), []);
  const [selectedQuoteToken, setSelectedQuoteToken] = useState<UcmQuoteToken>(() =>
    resolveInitialUcmQuoteToken()
  );

  const handleQuoteTokenChange = useCallback((tokenId: string) => {
    const next = getUcmQuoteToken(tokenId) || getDefaultUcmQuoteToken();
    setSelectedQuoteToken(next);
    rememberPreferredUcmQuoteTokenId(next.id);
  }, []);

  const canShowListingPanel = useMemo(() => {
    if (assumeOwner) return true;
    if (walletType !== 'arweave' || !address) return false;

    const wallet = address.toLowerCase();
    const creator = String(assetCreatorHint || '').trim().toLowerCase();
    if (creator) return creator === wallet;

    if (profileHasAsset) return true;
    if (balance != null && balance > 0) return true;
    return false;
  }, [address, assetCreatorHint, assumeOwner, balance, profileHasAsset, walletType]);

  useEffect(() => {
    let cancelled = false;
    void resolveCanonicalAtomicAssetId(assetId)
      .then((id) => {
        if (!cancelled) setUcmAssetId(id);
      })
      .catch(() => {
        if (!cancelled) setUcmAssetId(assetId);
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
        // Show asks across all market tokens; listing form uses selectedQuoteToken.
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
  }, [address, knownOrderbookId, ucmAssetId, profileId, walletType]);

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
        setBalanceWallet(null);
        setBalanceProfile(null);
        setBalanceInferred(false);
        setBalanceEmptyConfirmed(false);
        setBalanceEscrowed(0);
        setBalanceUncredited(0);
        setBalanceTotalSupply(null);
        setBalanceLoading(false);
        return;
      }
      setBalanceLoading(true);
      const result = await fetchSellerAssetBalance({
        assetId: ucmAssetId,
        walletAddress: address,
        profileId,
        creatorHint: assetCreatorHint,
      }).catch(() => ({
        copies: 0,
        walletCopies: 0,
        profileCopies: 0,
        inferredFromCreator: false,
        balancesEmptyConfirmed: false,
        escrowedCopies: 0,
        uncreditedCopies: 0,
        totalSupply: undefined as number | undefined,
      }));
      if (cancelled) return;
      setBalance(result.copies);
      setBalanceWallet(Math.max(0, Math.floor(result.walletCopies || 0)));
      setBalanceProfile(Math.max(0, Math.floor(result.profileCopies || 0)));
      setBalanceInferred(result.inferredFromCreator);
      setBalanceEmptyConfirmed(Boolean(result.balancesEmptyConfirmed));
      setBalanceEscrowed(Math.max(0, Math.floor(result.escrowedCopies || 0)));
      setBalanceUncredited(Math.max(0, Math.floor(result.uncreditedCopies || 0)));
      setBalanceTotalSupply(
        result.totalSupply != null && result.totalSupply > 0 ? result.totalSupply : null
      );
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
  }, [address, assetCreatorHint, ucmAssetId, profileId, selectedQuoteToken.id, walletType]);

  useEffect(() => {
    void refreshDedicatedOrderbook();
  }, [refreshDedicatedOrderbook]);

  useEffect(() => {
    void refreshActiveOrders();
  }, [refreshActiveOrders]);

  const handleCancel = useCallback(
    async (order: UcmActiveOrder) => {
      if (!address) return;
      if (order.escrowedUnread || isEscrowedUnreadOrderId(order.orderId)) {
        setStatus({
          processing: false,
          success: false,
          message:
            'Ask is not readable on the orderbook yet (copies are escrowed). Cancel is unavailable until the sell order appears — try Refresh, or check Bazar.',
        });
        return;
      }
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
          walletCopies: 0,
          profileCopies: 0,
          inferredFromCreator: false,
          balancesEmptyConfirmed: false,
        }));
        setBalance(bal.copies);
        setBalanceWallet(Math.max(0, Math.floor(bal.walletCopies || 0)));
        setBalanceProfile(Math.max(0, Math.floor(bal.profileCopies || 0)));
        setBalanceInferred(bal.inferredFromCreator);
        setBalanceEmptyConfirmed(Boolean(bal.balancesEmptyConfirmed));
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
      const isOwner =
        assumeOwner ||
        (Boolean(assetCreatorHint) &&
          Boolean(address) &&
          String(assetCreatorHint).trim().toLowerCase() === address.toLowerCase());
      if (maxQty != null && maxQty <= 0 && !isOwner) {
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
        orderbookIdHint: knownOrderbookId,
        creatorHint: assetCreatorHint,
        balancesEmptyConfirmed: balanceEmptyConfirmed || balanceInferred,
        quantity: qty,
        priceQuote: priceAr,
        quoteTokenId: selectedQuoteToken.id,
        onStatus: setStatus,
      });
      setKnownOrderbookId(result.orderbookId);
      rememberAssetOrderbookId(ucmAssetId, result.orderbookId);
      rememberAssetListingAttempt(ucmAssetId, {
        orderbookId: result.orderbookId,
        quoteTokenId: selectedQuoteToken.id,
        quoteSymbol: selectedQuoteToken.symbol,
        priceDisplay: String(priceAr || '').trim() || '—',
        priceWinston: tokenDisplayToBaseUnits(String(priceAr || '0'), selectedQuoteToken.denomination),
        quantity: String(qty),
      });

      // Refresh wallet / escrow breakdown after Transfer (ask-live or escrowed-unread).
      const bal = await fetchSellerAssetBalance({
        assetId: ucmAssetId,
        walletAddress: address,
        profileId,
        creatorHint: assetCreatorHint,
      }).catch(() => null);
      if (bal) {
        setBalance(bal.copies);
        setBalanceWallet(Math.max(0, Math.floor(bal.walletCopies || 0)));
        setBalanceProfile(Math.max(0, Math.floor(bal.profileCopies || 0)));
        setBalanceInferred(bal.inferredFromCreator);
        setBalanceEmptyConfirmed(Boolean(bal.balancesEmptyConfirmed));
        setBalanceEscrowed(Math.max(0, Math.floor(bal.escrowedCopies || 0)));
        setBalanceUncredited(Math.max(0, Math.floor(bal.uncreditedCopies || 0)));
        setBalanceTotalSupply(
          bal.totalSupply != null && bal.totalSupply > 0 ? bal.totalSupply : null
        );
      }

      let foundAskDuringRefresh = result.askStatus === 'ask-live';
      // Only poll listings when ask may still appear — skip long loops once escrowed-unread.
      const refreshRounds =
        result.askStatus === 'ask-live' ? 1 : result.askStatus === 'escrowed-unread' ? 2 : 4;
      for (let i = 0; i < refreshRounds; i++) {
        setStatus({
          processing: true,
          success: false,
          message: `Refreshing your listings (${i + 1}/${refreshRounds})…`,
        });
        await refreshActiveOrders();
        try {
          const { orders } = await fetchWalletListingsForAsset({
            assetId: ucmAssetId,
            walletAddress: address,
            profileId,
            quoteTokenId: selectedQuoteToken.id,
            orderbookIdHint: result.orderbookId,
          });
          if (orders.length > 0) foundAskDuringRefresh = true;
        } catch {
          // keep polling
        }
        if (foundAskDuringRefresh) break;
        if (i < refreshRounds - 1) await new Promise((r) => setTimeout(r, 1500));
      }
      await refreshDedicatedOrderbook();

      if (foundAskDuringRefresh) {
        setStatus({
          processing: false,
          success: true,
          message:
            `Ask live on UCM. On Bazar, open this asset and select ${selectedQuoteToken.symbol} as the market token.`,
        });
        window.dispatchEvent(new Event('streamvault:marketplace-updated'));
      } else if (result.askStatus === 'escrowed-unread' || (bal?.escrowedCopies || 0) > 0) {
        setStatus({
          processing: false,
          success: false,
          message:
            `Escrowed in orderbook — ask not readable yet. Your listings may catch up after Refresh, ` +
            `or check Bazar with ${selectedQuoteToken.symbol}.`,
        });
      } else {
        setStatus({
          processing: false,
          success: false,
          message:
            `Transfer submitted but UCM ask was not confirmed. Try Refresh listings or open Bazar with ${selectedQuoteToken.symbol}.`,
        });
      }
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
  }, [address, assetId, assetCreatorHint, assumeOwner, balanceEmptyConfirmed, balanceInferred, ucmAssetId, connect, isLegacyProfile, knownOrderbookId, maxQty, parsedQuantity, priceAr, profileHasAsset, profileId, refreshActiveOrders, refreshDedicatedOrderbook, selectedQuoteToken.id, selectedQuoteToken.symbol, walletType]);

  if (!canShowListingPanel) return null;

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
          Sell copies on UCM for any Bazar market token (wAR, PI, AO, USDA…). First list spawns a dedicated
          orderbook + activity process for this asset. On Bazar, open the asset and select the same market
          token to see your ask.
        </p>
      ) : null}

      <p className={styles.alphaWarning}>
        <strong>Alpha UCM listing.</strong> Listing may escrow your asset before the sell order is readable on
        UCM/Bazar. Use low-value test assets, refresh after listing, and avoid listing anything you cannot
        afford to have temporarily locked while orderbook state syncs.
      </p>

      {balanceLoading ? (
        <p className={styles.balance}>Checking balance…</p>
      ) : balance != null ? (
        <div className={styles.balance}>
          <p className={styles.balance}>
            Available to list: <strong>{balance}</strong>
            {balanceInferred ? (
              <span className={styles.balanceNote}>
                {balanceEmptyConfirmed
                  ? ' (not credited yet — List will Init/Mint)'
                  : ' (syncing)'}
              </span>
            ) : null}
          </p>
          <p className={styles.balanceNote}>
            Wallet: <strong>{balanceWallet ?? 0}</strong>
            {profileId || (balanceProfile || 0) > 0 ? (
              <>
                {' '}
                · Profile zone: <strong>{balanceProfile ?? 0}</strong>
              </>
            ) : null}
          </p>
          {balanceEscrowed > 0 ? (
            <p className={styles.balanceNote}>
              Listed / escrowed in orderbook: <strong>{balanceEscrowed}</strong>
            </p>
          ) : null}
          {balanceTotalSupply != null ? (
            <p className={styles.balanceNote}>
              Edition size: <strong>{balanceTotalSupply}</strong>
              {balanceUncredited > 0 ? (
                <>
                  {' '}
                  · <strong>{balanceUncredited}</strong> never credited on-chain (Init/Mint only funded{' '}
                  {(balanceTotalSupply || 0) - balanceUncredited})
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}

      <label className={styles.label}>
        Market token
        <select
          className={styles.input}
          value={selectedQuoteToken.id}
          onChange={(e) => handleQuoteTokenChange(e.target.value)}
          disabled={isListing || quoteTokens.length === 0}
          aria-label="UCM market token"
        >
          {quoteTokens.map((token) => (
            <option key={token.id} value={token.id}>
              {token.symbol} — {token.name}
            </option>
          ))}
        </select>
      </label>

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
        aria-busy={isListing}
      >
        {isListing ? <span className={styles.spinner} aria-hidden /> : null}
        {isListing
          ? 'Listing…'
          : canList
            ? parsedQuantity === 1
              ? `List for ${selectedQuoteToken.symbol}`
              : `List ${parsedQuantity} for ${selectedQuoteToken.symbol}`
            : 'Connect Wander to list'}
      </button>

      {status?.message ? (
        <p
          className={`${styles.statusRow} ${
            status.success ? styles.success : status.processing ? styles.status : styles.error
          }`}
          role={status.processing ? 'status' : undefined}
          aria-live="polite"
        >
          {status.processing ? <span className={styles.statusSpinner} aria-hidden /> : null}
          <span>{status.message}</span>
        </p>
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
                      {order.escrowedUnread
                        ? order.priceDisplay === '—'
                          ? `Escrowed · ${order.quantity}`
                          : `${order.priceDisplay} ${order.quoteSymbol} · escrowed`
                        : `${order.priceDisplay} ${order.quoteSymbol}`}
                    </strong>
                    {!order.escrowedUnread ? (
                      <span className={styles.activeQty}> · {order.quantity}</span>
                    ) : (
                      <span className={styles.activeQty}>
                        {' '}
                        · ask syncing on {order.orderbookId.slice(0, 8)}…
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className={styles.cancelBtn}
                    disabled={Boolean(cancellingId) || Boolean(order.escrowedUnread)}
                    title={
                      order.escrowedUnread
                        ? 'Cancel unavailable until the ask is readable on the orderbook'
                        : undefined
                    }
                    onClick={() => void handleCancel(order)}
                  >
                    {cancellingId === order.orderId ? '…' : order.escrowedUnread ? 'Pending' : 'Cancel'}
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
