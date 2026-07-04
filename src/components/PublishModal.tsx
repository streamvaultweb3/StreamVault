import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Track } from '../context/PlayerContext';
import { usePermaweb } from '../context/PermawebContext';
import { useWallet } from '../context/WalletContext';
import { useGeneratedCover } from '../context/GeneratedCoverContext';
import { useGeneratedAudio } from '../context/GeneratedAudioContext';
import { useAudiusAuth } from '../context/AudiusAuthContext';
import { type PublishResult } from '../lib/arweave';
import { getSelectedOrLatestProfileByWallet, resolveProfilePublicPath } from '../lib/permaProfile';
import { fetchAudiusStreamAsBlob } from '../lib/audius';
import { arweaveTxDataUrl, arweaveTxMetaUrl } from '../lib/arweaveDataGateway';
import { publishFullAsAtomicAsset, createFiatTopUpSession } from '../lib/publish';
import { fetchTurboBalance, formatTurboCredits, type TurboBalance } from '../lib/turboCredits';
import { fetchL1CostForBytes, fetchTurboCostForBytes, formatArFromWinston } from '../lib/uploadCosts';
import { appendUploadLedger } from '../lib/uploadLedger';
import type { UdlConfig, RoyaltySplit, UdlAiUse } from '../lib/udl';
import { udlToSummary } from '../lib/uploadedTracks';
import { PublishPrimaryUpload } from './publish/PublishPrimaryUpload';
import { ListOnUcm } from './ListOnUcm';
import styles from './PublishModal.module.css';

interface PublishModalProps {
  track?: Track;
  onClose: () => void;
  onSuccess?: (result: PublishResult) => void;
}

export function PublishModal({ track, onClose, onSuccess }: PublishModalProps) {
  const { libs } = usePermaweb();
  const { address, walletType, connect, isConnecting } = useWallet();
  const {
    audiusUser,
    login: audiusLogin,
    logout: audiusLogout,
    apiKeyConfigured,
    isLoggingIn: isAudiusLoggingIn,
  } = useAudiusAuth();
  const { generatedCover, clearGeneratedCover } = useGeneratedCover();
  const { generatedAudio, clearGeneratedAudio } = useGeneratedAudio();
  const isAudiusBackedTrack = Boolean(track?.streamUrl && !track?.isPermanent && !track?.permaTxId && !track?.assetId);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'confirming' | 'done' | 'error'>('idle');
  type PublishStage =
    | 'idle'
    | 'preparing'
    | 'uploading-cover'
    | 'uploading-audio'
    | 'confirming'
    | 'waiting-gateway'
    | 'creating-atomic-asset'
    | 'registering-ao'
    | 'done'
    | 'error';
  const [publishStage, setPublishStage] = useState<PublishStage>('idle');
  const [audioProgress, setAudioProgress] = useState<{ processedBytes: number; totalBytes: number } | null>(null);
  const [coverProgress, setCoverProgress] = useState<{ processedBytes: number; totalBytes: number } | null>(null);
  const [currentTxId, setCurrentTxId] = useState<string | null>(null);
  const [currentArtworkTxId, setCurrentArtworkTxId] = useState<string | null>(null);
  const isSubmittingRef = useRef(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fullFile, setFullFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  const [royaltiesBps, setRoyaltiesBps] = useState<number>(500);
  const [useTurbo, setUseTurbo] = useState(true);
  const [turboToken, setTurboToken] = useState<'arweave' | 'ethereum' | 'base-eth' | 'solana' | 'base-usdc' | 'base-ario' | 'polygon-usdc' | 'pol'>('arweave');
  /** License, UDL, cover, royalties, L1 fallback, full Turbo / payment UI */
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copiedTxId, setCopiedTxId] = useState(false);
  const [copiedAudioUrl, setCopiedAudioUrl] = useState(false);
  const [appendWarning, setAppendWarning] = useState<string | null>(null);
  const [fiatAmount, setFiatAmount] = useState<string>('10');
  const [isTopUpLoading, setIsTopUpLoading] = useState(false);
  const [showWalletChooser, setShowWalletChooser] = useState(false);
  const [turboBalance, setTurboBalance] = useState<TurboBalance | null>(null);
  const [turboBalanceLoading, setTurboBalanceLoading] = useState(false);
  const [turboBalanceError, setTurboBalanceError] = useState<string | null>(null);
  const [turboCostEstimate, setTurboCostEstimate] = useState<number | null>(null);
  const [l1CostEstimate, setL1CostEstimate] = useState<number | null>(null);
  const [costEstimateLoading, setCostEstimateLoading] = useState(false);
  const [costEstimateError, setCostEstimateError] = useState<string | null>(null);
  /** When publishing full tier from an Audius-backed track, download bytes from streamUrl (CORS permitting). */
  const [useAudiusStreamForFull, setUseAudiusStreamForFull] = useState(isAudiusBackedTrack);
  /** Experimental: permaweb-libs createAtomicAsset can break with HyperBEAM/system changes. Default off. */
  const [createAtomicAssetExperimental, setCreateAtomicAssetExperimental] = useState(false);

  // Simple UDL controls
  const [licenseUsePreset, setLicenseUsePreset] = useState<'stream' | 'stream-download' | 'stream-download-commercial'>('stream');
  const [aiUse, setAiUse] = useState<UdlAiUse>('deny');
  const [licenseFee, setLicenseFee] = useState<string>('0');
  const [licenseCurrency, setLicenseCurrency] = useState<string>('MATIC');

  // New states for global upload where track is undefined
  const [customTitle, setCustomTitle] = useState(track?.title || '');
  const [customArtist, setCustomArtist] = useState(track?.artist || '');

  type PaymentChip = 'turbo-arweave' | 'turbo-solana' | 'turbo-evm' | 'l1-ar';

  const isBusy = status === 'uploading' || status === 'confirming' || publishStage !== 'idle' && publishStage !== 'done' && publishStage !== 'error';

  const resetPublishUi = useCallback(() => {
    isSubmittingRef.current = false;
    setStatus('idle');
    setPublishStage('idle');
    setAudioProgress(null);
    setCoverProgress(null);
    setCurrentTxId(null);
    setCurrentArtworkTxId(null);
    setResult(null);
    setErrorMessage(null);
    setAppendWarning(null);
    setCopiedTxId(false);
    setCopiedAudioUrl(false);
  }, []);

  const handleClose = useCallback(() => {
    resetPublishUi();
    onClose();
  }, [onClose, resetPublishUi]);

  const primaryPaymentChips = useMemo<PaymentChip[]>(() => {
    // Keep the main flow simple:
    // - Arweave connected: Turbo credits + AR (L1)
    // - Solana connected: Turbo (SOL)
    // - EVM connected: Turbo (EVM) (advanced users)
    // - No wallet: show Turbo options (L1 requires Wander)
    if (walletType === 'arweave') return ['turbo-arweave', 'l1-ar'];
    if (walletType === 'solana') return ['turbo-solana'];
    if (walletType === 'ethereum') return ['turbo-evm'];
    return ['turbo-arweave', 'turbo-solana'];
  }, [walletType]);

  const profileLink = useMemo(() => {
    const cachedProfileId =
      address && typeof window !== 'undefined'
        ? localStorage.getItem(`streamvault:lastProfileId:${address.toLowerCase()}`)
        : null;
    return `/#${resolveProfilePublicPath({ walletAddress: address, cachedProfileId })}`;
  }, [address]);

  const activePaymentChip = useMemo(() => {
    if (!useTurbo) return 'l1-ar' as PaymentChip;
    if (turboToken === 'solana') return 'turbo-solana' as PaymentChip;
    if (turboToken !== 'arweave') return 'turbo-evm' as PaymentChip;
    return 'turbo-arweave' as PaymentChip;
  }, [turboToken, useTurbo]);

  const handleSelectPaymentChip = useCallback(
    (chip: PaymentChip) => {
      if (chip === 'l1-ar') {
        setUseTurbo(false);
        setTurboToken('arweave');
        return;
      }
      setUseTurbo(true);
      if (chip === 'turbo-solana') {
        setTurboToken('solana');
        return;
      }
      if (chip === 'turbo-evm') {
        setTurboToken('ethereum');
        return;
      }
      setTurboToken('arweave');
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!useTurbo || !address || walletType !== 'arweave') {
        setTurboBalance(null);
        setTurboBalanceError(null);
        setTurboBalanceLoading(false);
        return;
      }
      setTurboBalanceLoading(true);
      setTurboBalanceError(null);
      try {
        const next = await fetchTurboBalance(address);
        if (!cancelled) setTurboBalance(next);
      } catch (e: any) {
        if (!cancelled) {
          setTurboBalance(null);
          setTurboBalanceError(e?.message || 'Failed to load Turbo credits.');
        }
      } finally {
        if (!cancelled) setTurboBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address, useTurbo, walletType]);

  const estimatedByteCount = fullFile?.size ?? generatedAudio?.size ?? null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!estimatedByteCount || estimatedByteCount <= 0) {
        setTurboCostEstimate(null);
        setL1CostEstimate(null);
        setCostEstimateError(null);
        setCostEstimateLoading(false);
        return;
      }
      setCostEstimateLoading(true);
      setCostEstimateError(null);
      try {
        const [turboWinc, l1Winston] = await Promise.all([
          fetchTurboCostForBytes(estimatedByteCount),
          fetchL1CostForBytes(estimatedByteCount),
        ]);
        if (!cancelled) {
          setTurboCostEstimate(turboWinc);
          setL1CostEstimate(l1Winston);
        }
      } catch (e: any) {
        if (!cancelled) {
          setTurboCostEstimate(null);
          setL1CostEstimate(null);
          setCostEstimateError(e?.message || 'Failed to estimate upload cost.');
        }
      } finally {
        if (!cancelled) setCostEstimateLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [estimatedByteCount]);

  const handleCopyTxId = async (txId: string) => {
    try {
      await navigator.clipboard.writeText(txId);
      setCopiedTxId(true);
      window.setTimeout(() => setCopiedTxId(false), 1500);
    } catch (e) {
      console.warn('[publish] Clipboard copy failed', e);
    }
  };

  const handleCopyAudioUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedAudioUrl(true);
      window.setTimeout(() => setCopiedAudioUrl(false), 1500);
    } catch (e) {
      console.warn('[publish] Clipboard copy failed', e);
    }
  };

  const handleFiatTopUp = async () => {
    if (!address) {
      setErrorMessage('Connect a wallet first to use as the top-up destination.');
      return;
    }
    const amount = parseInt(fiatAmount, 10);
    if (isNaN(amount) || amount < 5) {
      setErrorMessage('Top-up amount must be at least $5.');
      return;
    }
    try {
      setIsTopUpLoading(true);
      setErrorMessage(null);
      const url = await createFiatTopUpSession({ amountUsd: amount, ownerAddress: address });
      window.location.href = url;
    } catch (e: any) {
      setErrorMessage(e?.message || 'Failed to initialize Stripe checkout.');
    } finally {
      setIsTopUpLoading(false);
    }
  };

  const openTurboTopUp = () => {
    window.open('https://turbo.ar.io/topup', '_blank', 'noopener,noreferrer');
  };

  const openTurboPricingCalculator = () => {
    window.open('https://prices.ardrive.io/', '_blank', 'noopener,noreferrer');
  };

  const buildUdlConfig = (): UdlConfig => {
    const usage =
      licenseUsePreset === 'stream'
        ? ['stream']
        : licenseUsePreset === 'stream-download'
          ? ['stream', 'download']
          : ['stream', 'download', 'commercial-sync'];

    const fee = licenseFee.trim() || '0';

    return {
      licenseId: 'udl://music/1.0',
      uri: (import.meta as any).env?.VITE_UDL_LICENSE_URI || undefined,
      usage,
      aiUse,
      fee,
      currency: licenseCurrency || 'MATIC',
      interval: 'per-stream',
      attribution: 'required',
    };
  };

  const buildDefaultSplits = (): RoyaltySplit[] => {
    if (!address) return [];
    let chain: RoyaltySplit['chain'] = 'arweave';
    let token = 'AR';

    if (useTurbo) {
      if (turboToken === 'base-eth' || turboToken === 'base-usdc' || turboToken === 'base-ario') {
        chain = 'base';
        token = turboToken === 'base-eth' ? 'ETH' : turboToken === 'base-usdc' ? 'USDC' : 'ARIO';
      } else if (turboToken === 'polygon-usdc' || turboToken === 'pol') {
        chain = 'polygon';
        token = turboToken === 'polygon-usdc' ? 'USDC' : 'POL';
      } else if (turboToken === 'solana') {
        chain = 'solana';
        token = 'SOL';
      }
    } else if (walletType === 'ethereum') {
      chain = 'ethereum';
      token = 'ETH';
    } else if (walletType === 'solana') {
      chain = 'solana';
      token = 'SOL';
    }

    return [
      {
        address,
        shareBps: 10_000,
        chain,
        token,
      },
    ];
  };

  const handlePublish = async () => {
    if (isSubmittingRef.current) return;
    if (!address || !walletType || !libs) {
      // Show inline wallet chooser instead of a plain error
      setShowWalletChooser(true);
      return;
    }
    isSubmittingRef.current = true;
    setStatus('uploading');
    setPublishStage('preparing');
    setErrorMessage(null);
    setAppendWarning(null);
    setAudioProgress(null);
    setCoverProgress(null);
    setCurrentTxId(null);
    setCurrentArtworkTxId(null);
    try {
      let effectiveAudio: Blob | File | null =
        fullFile || (generatedAudio ? new File([generatedAudio], 'generated-beat.wav', { type: 'audio/wav' }) : null);
      if (!effectiveAudio && useAudiusStreamForFull && track?.streamUrl) {
        try {
          const maxBytes = useTurbo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
          effectiveAudio = await fetchAudiusStreamAsBlob(track.streamUrl, { maxBytes });
        } catch (e: any) {
          setStatus('error');
          const message = String(e?.message || e || '').trim();
          setErrorMessage(
            message === 'Failed to fetch'
              ? 'Could not download the full track from the Audius stream. This is usually a browser CORS/CDN issue before upload begins. Upload the audio file from disk instead, or retry later if the Audius stream becomes reachable.'
              : message ||
                  'Could not download the full track from the Audius stream (often CORS or size). Upload the audio file from disk instead.'
          );
          return;
        }
      }
      if (!effectiveAudio) {
        setStatus('error');
        setPublishStage('error');
        setErrorMessage(
          'Choose an audio file, enable “Use Audius stream as full audio” if this track is playing from Audius, or generate a beat in Creator tools and use “Use in Publish”.'
        );
        isSubmittingRef.current = false;
        return;
      }
      if (!description.trim()) {
        setDescriptionTouched(true);
        setStatus('error');
        setPublishStage('error');
        setErrorMessage('Add a description before uploading. It helps discovery and attribution on the permaweb.');
        isSubmittingRef.current = false;
        return;
      }
      if (useTurbo) {
        const needWallet =
          turboToken === 'arweave'
            ? walletType === 'arweave'
            : turboToken === 'solana'
              ? walletType === 'solana'
              : walletType === 'ethereum';
        if (!needWallet) {
          setStatus('error');
          setPublishStage('error');
          setErrorMessage('Connect the matching wallet for the selected Turbo payment option.');
          isSubmittingRef.current = false;
          return;
        }
      } else if (walletType !== 'arweave') {
        setStatus('error');
        setPublishStage('error');
        setErrorMessage('Connect Wander (Arweave) for non-Turbo full uploads.');
        isSubmittingRef.current = false;
        return;
      }
      if (!useTurbo && effectiveAudio.size > 10 * 1024 * 1024) {
        setStatus('error');
        setPublishStage('error');
        setErrorMessage('Full asset must be under ~10MB unless using Turbo.');
        isSubmittingRef.current = false;
        return;
      }
      const udlConfig = buildUdlConfig();
      const splits = buildDefaultSplits();
      const skipAtomicAsset = !createAtomicAssetExperimental;

      // Audius-backed tracks: upload cover from track metadata unless the user picked a local file.
      // Do not let a stale "generated" cover from Creator tools suppress Audius artwork (that skipped
      // fetchArtworkAsBlob + Turbo/L1 artwork upload and left artworkTxId unset).
      const audiusArtworkUrl = track?.artwork?.trim() || '';
      const useGeneratedCoverAsFile = Boolean(
        generatedCover && !(isAudiusBackedTrack && audiusArtworkUrl)
      );
      const effectiveArtworkFile =
        coverFile || (useGeneratedCoverAsFile ? generatedCover : undefined) || undefined;
      const effectiveArtworkUrl =
        coverFile || effectiveArtworkFile ? undefined : audiusArtworkUrl || undefined;

      const res: PublishResult = await publishFullAsAtomicAsset(
        {
          audio: effectiveAudio,
          title: customTitle || 'Unknown Track',
          artist: customArtist || 'Unknown Artist',
          description: description.trim() || undefined,
          artworkUrl: effectiveArtworkUrl,
          artworkFile: effectiveArtworkFile,
          royaltiesBps: Number.isFinite(royaltiesBps) ? royaltiesBps : undefined,
          udl: udlConfig,
          splits,
          useTurbo,
          turboPaymentToken: turboToken,
          skipAtomicAsset,
          audiusTrackId: isAudiusBackedTrack ? track?.id : undefined,
          fromAudiusStream: Boolean(useAudiusStreamForFull && track?.streamUrl),
        },
        address,
        { libs },
        {
          onStage: (stage) => {
            setPublishStage(stage);
            if (stage === 'confirming') setStatus('confirming');
          },
          onProgress: (p) => {
            if (p.kind === 'audio') setAudioProgress({ processedBytes: p.processedBytes, totalBytes: p.totalBytes });
            if (p.kind === 'cover') setCoverProgress({ processedBytes: p.processedBytes, totalBytes: p.totalBytes });
          },
          onTxId: (txId) => setCurrentTxId(txId),
          onArtworkTxId: (txId) => setCurrentArtworkTxId(txId),
        }
      );
      if (res.success) {
        clearGeneratedCover();
        clearGeneratedAudio();
        if (useTurbo && address && walletType === 'arweave') {
          try {
            const nextBalance = await fetchTurboBalance(address);
            setTurboBalance(nextBalance);
          } catch {
            // ignore post-upload refresh failures
          }
          try {
            window.dispatchEvent(new CustomEvent('streamvault:turbo-balance-refresh'));
          } catch {
            // ignore
          }
        }
      }
      setResult(res);
      setStatus(res.success ? 'done' : 'error');
      setPublishStage(res.success ? 'done' : 'error');
      if (res.error) setErrorMessage(res.error);
      console.info('[publish] Result', res);
      if (res.success && res.txId && address) {
        try {
          const entryBase = {
            txId: res.txId,
            title: customTitle || 'Unknown Track',
            artist: customArtist || 'Unknown Artist',
            permawebUrl: res.permawebUrl,
            arioUrl: res.arioUrl,
            confirmed: res.confirmed,
            gatewayReady: res.gatewayReady,
            assetId: res.assetId,
            createdAt: new Date().toISOString(),
            audiusTrackId: isAudiusBackedTrack && track?.id != null && String(track.id).trim() ? String(track.id) : undefined,
            description: description.trim() || undefined,
            artworkTxId: res.artworkTxId,
            artworkUrl:
              res.artworkTxId
                ? arweaveTxDataUrl(res.artworkTxId)
                : typeof track?.artwork === 'string' && track.artwork.trim()
                  ? track.artwork
                  : undefined,
            contentType: effectiveAudio.type || 'audio/mpeg',
            udl: udlToSummary(udlConfig),
            splits,
          };
          appendUploadLedger({
            ...entryBase,
            walletAddress: address,
            tier: 'full',
            dataTxOnly: skipAtomicAsset,
          });
          if (walletType === 'arweave' && libs?.addToZone) {
            const profile = await getSelectedOrLatestProfileByWallet(libs, address);
            if (profile?.id) {
              await libs.addToZone(
                {
                  path: 'ArweaveTracks[]',
                  data: {
                    ...entryBase,
                  },
                },
                profile.id
              );
              try {
                window.dispatchEvent(new CustomEvent('streamvault:profile-updated'));
              } catch {
                // ignore
              }
            } else {
              setAppendWarning('Create a permaweb profile to list this on your permaweb profile on-chain.');
            }
          } else if (walletType === 'arweave') {
            setAppendWarning('Permaweb profile tools are not ready yet. Try again later.');
          } else {
            setAppendWarning(
              'Upload recorded on this device. Connect Wander and open your profile to sync to your permaweb zone, or use “Add existing upload” with this tx id.'
            );
          }
          const legacyKey = `streamvault:samples:${address.toLowerCase()}`;
          const tracksKey = `streamvault:myTracks:${address.toLowerCase()}`;
          const existing = JSON.parse(localStorage.getItem(tracksKey) || '[]') as Array<Record<string, any>>;
          const entry = { ...entryBase };
          localStorage.setItem(tracksKey, JSON.stringify([entry, ...existing].slice(0, 50)));
          try {
            const legacy = JSON.parse(localStorage.getItem(legacyKey) || '[]') as Array<Record<string, any>>;
            localStorage.setItem(legacyKey, JSON.stringify([entry, ...legacy].slice(0, 50)));
          } catch {
            // ignore legacy mirror failures
          }
          try {
            window.dispatchEvent(new CustomEvent('streamvault:uploads-updated'));
          } catch {
            // ignore
          }
        } catch (e) {
          console.warn('[publish] Failed to persist local record', e);
          setAppendWarning('Upload saved locally only. Create a permaweb profile to store it on-chain.');
        }
      }
      if (res.success && onSuccess) onSuccess(res);

      if (res.success) {
        // prevent accidental re-submit of same file if user re-opens immediately
        setFullFile(null);
        setCoverFile(null);
        window.setTimeout(() => {
          resetPublishUi();
          onClose();
        }, 900);
      } else {
        isSubmittingRef.current = false;
      }
    } catch (e: any) {
      console.error('[publish] Publish failed', e);
      setResult({ success: false, error: e?.message || 'Publish failed' });
      setErrorMessage(e?.message || 'Publish failed');
      setStatus('error');
      setPublishStage('error');
      isSubmittingRef.current = false;
    }
  };

  const stageLabel = useMemo(() => {
    if (publishStage === 'idle') return null;
    if (publishStage === 'preparing') return 'Preparing upload…';
    if (publishStage === 'uploading-cover') return 'Uploading cover…';
    if (publishStage === 'uploading-audio') return 'Uploading audio…';
    if (publishStage === 'confirming') return 'Waiting for Arweave confirmation…';
    if (publishStage === 'waiting-gateway') return 'Waiting for gateways to serve audio…';
    if (publishStage === 'creating-atomic-asset') return 'Creating atomic asset…';
    if (publishStage === 'registering-ao') return 'Registering on AO (best-effort)…';
    if (publishStage === 'done') return 'Done.';
    if (publishStage === 'error') return 'Upload failed.';
    return null;
  }, [publishStage]);

  const progressPct = (p: { processedBytes: number; totalBytes: number } | null) => {
    if (!p || !p.totalBytes) return null;
    const v = Math.max(0, Math.min(1, p.processedBytes / p.totalBytes));
    return Math.round(v * 100);
  };

  const isTransferStage = publishStage === 'uploading-cover' || publishStage === 'uploading-audio';
  const isWaitingStage =
    publishStage === 'preparing' ||
    publishStage === 'confirming' ||
    publishStage === 'waiting-gateway' ||
    publishStage === 'creating-atomic-asset' ||
    publishStage === 'registering-ao';

  const primaryButtonLabel = useMemo(() => {
    if (status === 'done') return 'Done';
    if (!address) return 'Connect wallet to upload';
    if (publishStage === 'preparing') return 'Preparing…';
    if (publishStage === 'uploading-cover' || publishStage === 'uploading-audio') return 'Uploading…';
    if (publishStage === 'confirming') return 'Confirming…';
    if (publishStage === 'waiting-gateway') return 'Waiting for gateways…';
    if (publishStage === 'creating-atomic-asset' || publishStage === 'registering-ao') return 'Finalizing…';
    if (isBusy) return 'Working…';
    return 'Upload';
  }, [address, isBusy, publishStage, status]);

  const txIdToShow = result?.txId || currentTxId;
  const permawebUrlToShow = result?.permawebUrl || (txIdToShow ? arweaveTxDataUrl(txIdToShow) : null);

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div className={styles.modal + ' glass-strong'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>Upload to Arweave</h2>
          <button type="button" className={styles.close} onClick={handleClose} aria-label="Close">×</button>
        </div>
        <p className={styles.subtitle}>
          Add your audio, choose a payment method, then publish. Open <strong>Advanced</strong> for license (UDL), cover art,
          royalties, and other networks/tokens.
        </p>
        <div className={styles.audiusCtaBox}>
          <div className={styles.audiusCtaText}>
            <strong>{audiusUser ? `Audius connected — @${audiusUser.handle}` : 'Connect Audius'}</strong>
            <span>
              {audiusUser
                ? 'Tracks + cover art import is ready.'
                : apiKeyConfigured
                  ? 'Pull your tracks + cover art into StreamVault for one-click publishing.'
                  : 'Audius login isn’t configured for this app. Add VITE_AUDIUS_API_KEY to enable imports.'}
            </span>
          </div>
          {audiusUser ? (
            <button type="button" className={styles.audiusCtaBtn} onClick={audiusLogout}>
              Disconnect
            </button>
          ) : (
            <button
              type="button"
              className={styles.audiusCtaBtn}
              onClick={audiusLogin}
              disabled={!apiKeyConfigured || isAudiusLoggingIn}
              title={!apiKeyConfigured ? 'Missing VITE_AUDIUS_API_KEY' : undefined}
            >
              {isAudiusLoggingIn ? 'Connecting…' : 'Connect Audius'}
            </button>
          )}
        </div>

        <div className={styles.trackPreview}>
          {!track ? (
            <div className={styles.blankUploadForm}>
              <label className={styles.label}>
                Track Title
                <input
                  type="text"
                  className={styles.input}
                  placeholder="e.g. Neon Horizon"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                />
              </label>
              <label className={styles.label}>
                Artist Name
                <input
                  type="text"
                  className={styles.input}
                  placeholder="e.g. The Midnight"
                  value={customArtist}
                  onChange={(e) => setCustomArtist(e.target.value)}
                />
              </label>
            </div>
          ) : (
            <>
              {track.artwork ? (
                <img src={track.artwork} alt="" className={styles.previewArt} />
              ) : (
                <div className={styles.previewArtPlaceholder} aria-hidden="true" />
              )}
              <div>
                <strong>{track.title}</strong>
                <span className={styles.previewArtist}>{track.artist}</span>
              </div>
            </>
          )}
        </div>

        <div className={styles.form}>
          <PublishPrimaryUpload
            fullFile={fullFile}
            onFileChange={setFullFile}
            coverFile={coverFile}
            onCoverChange={setCoverFile}
            hasGeneratedCover={Boolean(generatedCover)}
            onClearGeneratedCover={clearGeneratedCover}
            hasGeneratedAudio={Boolean(generatedAudio)}
            onClearGeneratedAudio={clearGeneratedAudio}
            disabled={isBusy}
          />
          <label className={styles.label}>
            Description
            <textarea
              className={`${styles.textarea} ${descriptionTouched && !description.trim() ? styles.inputError : ''}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => setDescriptionTouched(true)}
              placeholder="Credits, release notes, intent… (required)"
            />
          </label>
          {descriptionTouched && !description.trim() && (
            <p className={styles.fieldError}>Description is required.</p>
          )}
          <div className={styles.paymentQuickRow}>
            <span className={styles.turboBalanceLabel} style={{ marginBottom: 2 }}>
              Upload + payment
            </span>
            <div className={styles.paymentChipRow}>
              {primaryPaymentChips.includes('turbo-arweave') && (
                <button
                  type="button"
                  className={`${styles.paymentChip} ${activePaymentChip === 'turbo-arweave' ? styles.paymentChipActive : ''}`}
                  onClick={() => handleSelectPaymentChip('turbo-arweave')}
                >
                  Turbo credits (Wander)
                </button>
              )}
              {primaryPaymentChips.includes('turbo-solana') && (
                <button
                  type="button"
                  className={`${styles.paymentChip} ${activePaymentChip === 'turbo-solana' ? styles.paymentChipActive : ''}`}
                  onClick={() => handleSelectPaymentChip('turbo-solana')}
                >
                  Solana (SOL)
                </button>
              )}
              {primaryPaymentChips.includes('turbo-evm') && (
                <button
                  type="button"
                  className={`${styles.paymentChip} ${activePaymentChip === 'turbo-evm' ? styles.paymentChipActive : ''}`}
                  onClick={() => handleSelectPaymentChip('turbo-evm')}
                >
                  Ethereum (Turbo)
                </button>
              )}
              {primaryPaymentChips.includes('l1-ar') && (
                <button
                  type="button"
                  className={`${styles.paymentChip} ${activePaymentChip === 'l1-ar' ? styles.paymentChipActive : ''}`}
                  onClick={() => handleSelectPaymentChip('l1-ar')}
                >
                  AR (Arweave L1)
                </button>
              )}
            </div>
            <p className={styles.hint} style={{ marginTop: 0 }}>
              {useTurbo
                ? 'Turbo is recommended (large files OK). Select “AR (Arweave L1)” only as a fallback — it uses raw AR and can take longer.'
                : 'Direct L1 uses raw AR from Wander and may take longer to propagate on gateways. File size is limited (~10MB).'}
            </p>
            <button
              type="button"
              className={styles.advancedToggle}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? '▼ Hide advanced' : '▸ Advanced — license, cover, royalties & other tokens'}
            </button>
          </div>

          {(estimatedByteCount || costEstimateLoading || costEstimateError || turboCostEstimate !== null || l1CostEstimate !== null) && (
            <div className={styles.turboBalanceBox}>
              <span className={styles.turboBalanceLabel}>Estimated upload cost</span>
              {estimatedByteCount ? (
                <span className={styles.hint} style={{ marginTop: 0 }}>
                  Based on {(estimatedByteCount / (1024 * 1024)).toFixed(2)} MB of local audio data.
                </span>
              ) : (
                <span className={styles.hint} style={{ marginTop: 0 }}>
                  Select a file to estimate. Audius stream sources are sized after download.
                </span>
              )}
              {costEstimateLoading ? (
                <strong className={styles.turboBalanceValue}>Loading estimates…</strong>
              ) : (
                <>
                  {turboCostEstimate !== null && useTurbo && (
                    <strong className={styles.turboBalanceValue}>
                      Turbo: {formatTurboCredits(turboCostEstimate)}
                    </strong>
                  )}
                  {l1CostEstimate !== null && !useTurbo && (
                    <strong className={styles.turboBalanceValue}>
                      Direct L1: {formatArFromWinston(l1CostEstimate)}
                    </strong>
                  )}
                </>
              )}
              {costEstimateError && <span className={styles.turboBalanceError}>{costEstimateError}</span>}
            </div>
          )}

          {useTurbo && turboToken === 'arweave' && (
            <div className={styles.turboPanel}>
              <p className={styles.turboPanelHint}>
                Using <strong>Turbo credits</strong> from your Arweave wallet (Wander). Add credits if you’re low.
              </p>
              <div className={styles.turboBalanceBox}>
                <span className={styles.turboBalanceLabel}>Current Turbo balance</span>
                {walletType !== 'arweave' ? (
                  <strong className={styles.turboBalanceValue}>Connect an Arweave wallet to view credits</strong>
                ) : turboBalanceLoading ? (
                  <strong className={styles.turboBalanceValue}>Loading Turbo credits…</strong>
                ) : turboBalance ? (
                  <strong className={styles.turboBalanceValue}>
                    {formatTurboCredits(turboBalance.effectiveBalance)}
                  </strong>
                ) : (
                  <strong className={styles.turboBalanceValue}>Turbo credits unavailable</strong>
                )}
                {turboBalanceError && <span className={styles.turboBalanceError}>{turboBalanceError}</span>}
              </div>
              <div className={styles.turboModalActions}>
                <button type="button" className={styles.turboActionBtn} onClick={openTurboTopUp}>
                  Add
                </button>
                <button type="button" className={styles.turboActionBtn} onClick={openTurboPricingCalculator}>
                  Size Calculator
                </button>
              </div>
              <div className={styles.turboAmountRow}>
                <span style={{ fontSize: '1rem', fontWeight: 500 }}>$</span>
                <input
                  type="number"
                  min="5"
                  step="1"
                  className={styles.input}
                  style={{ width: '80px', margin: 0 }}
                  value={fiatAmount}
                  onChange={(e) => setFiatAmount(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.copyBtn}
                  onClick={handleFiatTopUp}
                  disabled={isTopUpLoading}
                  style={{ margin: 0, padding: '8px 16px', background: 'var(--accent-color)' }}
                >
                  {isTopUpLoading ? 'Loading…' : 'Buy Turbo credits with card'}
                </button>
              </div>
              <p className={styles.turboPanelHint} style={{ marginTop: 10 }}>
                Stripe top-up is <strong>experimental</strong> and depends on Turbo’s hosted checkout.
              </p>
            </div>
          )}

          {showAdvanced && (
            <div className={styles.advancedBlock}>
              <div className={styles.licenseBlock}>
                <p className={styles.licenseTitle}>License & usage (UDL)</p>
                <label className={styles.label}>
                  Usage
                  <select
                    className={styles.select}
                    value={licenseUsePreset}
                    onChange={(e) => setLicenseUsePreset(e.target.value as typeof licenseUsePreset)}
                  >
                    <option value="stream">Streaming only</option>
                    <option value="stream-download">Stream + personal download</option>
                    <option value="stream-download-commercial">Stream + download + commercial sync</option>
                  </select>
                </label>
                <label className={styles.label}>
                  AI use
                  <select
                    className={styles.select}
                    value={aiUse}
                    onChange={(e) => setAiUse(e.target.value as UdlAiUse)}
                  >
                    <option value="deny">No AI training or generation</option>
                    <option value="allow-train">Allow AI training only</option>
                    <option value="allow-generate">Allow training + generation</option>
                  </select>
                </label>
                <div className={styles.licenseRow}>
                  <label className={styles.label} style={{ flex: 1 }}>
                    License fee
                    <input
                      className={styles.input}
                      type="number"
                      min={0}
                      step={0.01}
                      value={licenseFee}
                      onChange={(e) => setLicenseFee(e.target.value)}
                    />
                  </label>
                  <label className={styles.label} style={{ flex: 1 }}>
                    Currency
                    <select
                      className={styles.select}
                      value={licenseCurrency}
                      onChange={(e) => setLicenseCurrency(e.target.value)}
                    >
                      <option value="U">$U (AO)</option>
                      <option value="MATIC">MATIC (Polygon)</option>
                      <option value="USDC.base">USDC (Base)</option>
                      <option value="AR">AR (Arweave)</option>
                    </select>
                  </label>
                </div>
                <p className={styles.hint}>
                  Applied as Arweave tags (and atomic asset metadata when minting).
                </p>
              </div>

              {isAudiusBackedTrack && (
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={useAudiusStreamForFull}
                    onChange={(e) => setUseAudiusStreamForFull(e.target.checked)}
                  />
                  <span>
                    Use Audius stream as full audio (requires browser access to the stream URL; you must own the rights).
                  </span>
                </label>
              )}
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={createAtomicAssetExperimental}
                  onChange={(e) => setCreateAtomicAssetExperimental(e.target.checked)}
                />
                <span>
                  Create atomic asset (experimental) — may break if HyperBEAM/system-wide changes roll out. Default is a
                  standard Arweave upload with UDL tags only.
                </span>
              </label>
              <label className={styles.label}>
                Royalties (bps)
                <input
                  className={styles.input}
                  type="number"
                  min={0}
                  max={5000}
                  value={royaltiesBps}
                  onChange={(e) => setRoyaltiesBps(Number(e.target.value))}
                />
              </label>

              {useTurbo && (
                <label className={styles.label}>
                  Upload payment (all networks)
                  <select
                    className={styles.select}
                    value={turboToken}
                    onChange={(e) => setTurboToken(e.target.value as typeof turboToken)}
                  >
                    <option value="arweave">Turbo credits with Wander signer</option>
                    <option value="ethereum">Turbo via Ethereum wallet</option>
                    <option value="base-eth">Turbo via Base wallet</option>
                    <option value="solana">Turbo via Solana wallet</option>
                    <option value="base-usdc">Turbo via Base USDC</option>
                    <option value="base-ario">Turbo via Base ARIO</option>
                    <option value="polygon-usdc">Turbo via Polygon USDC</option>
                    <option value="pol">Turbo via Polygon POL</option>
                  </select>
                </label>
              )}
              {useTurbo && (
                <p className={styles.hint}>
                  For Turbo credits (Wander), the top-up panel is now in the main flow. For other payment tokens, use the
                  selector above.
                </p>
              )}
              <p className={styles.hint}>
                {useTurbo
                  ? 'Turbo uploads bundle and speed up delivery; Wander credits or per-upload token payment both go through Turbo.'
                  : 'Direct L1 uses raw AR from Wander and may take longer to show up on gateways.'}
              </p>
            </div>
          )}
        </div>

        {status === 'done' && result?.success && (
          <div className={styles.success}>
            <span className={styles.successBadge}>Permanent</span>
            {(result.confirmed === false || result.gatewayReady === false) && (
              <span className={styles.pendingBadge}>
                {result.confirmed === false ? 'Pending' : 'Processing'}
              </span>
            )}
            <p className={styles.successText}>
              {result.confirmed === false
                ? 'Upload accepted. Waiting for block confirmation before gateways reliably stream the file.'
                : result.gatewayReady === false
                  ? 'Upload is confirmed on Arweave, but gateway playback is still propagating. The file exists, but streaming may not work yet.'
                  : 'Upload complete. Your full track is on Arweave.'}
            </p>
            {useTurbo && (
              <p className={styles.hint}>
                {turboToken === 'arweave' ? (
                  <>
                    This upload used <strong>Turbo credits</strong> from your Arweave wallet (not a raw L1 AR post).
                  </>
                ) : turboToken === 'solana' ? (
                  <>
                    This upload was paid with <strong>SOL</strong> through Turbo via your Solana wallet.
                  </>
                ) : (
                  <>
                    This upload used Turbo with payment token <strong>{turboToken}</strong>.
                  </>
                )}
              </p>
            )}
            {(useTurbo ? turboCostEstimate !== null : l1CostEstimate !== null) && (
              <p className={styles.hint}>
                Estimated cost:{' '}
                <strong>
                  {useTurbo
                    ? `~${formatTurboCredits(turboCostEstimate || 0)}`
                    : `~${formatArFromWinston(l1CostEstimate || 0)}`}
                </strong>
              </p>
            )}
            {(result.confirmed === false || result.gatewayReady === false) && result.txId && (
              <p className={styles.hint}>
                Until a gateway serves the audio body, opening the data link can return <strong>404</strong>,
                <strong> pending</strong>, or fail to stream even though the explorer already shows the transaction.
                Check the tx metadata here if you need the raw transaction record:{' '}
                <a
                  className={styles.link}
                  href={arweaveTxMetaUrl(result.txId)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View tx JSON
                </a>
                . Retry the same gateway link after confirmations and gateway propagation catch up.
              </p>
            )}
            {(result.permawebUrl || result.arioUrl) && (
              <>
                <a
                  href={result.arioUrl || result.permawebUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.link}
                >
                  Verify audio URL
                </a>
                {result.permawebUrl && result.arioUrl && result.arioUrl !== result.permawebUrl && (
                  <a href={result.arioUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
                    Alternate gateway
                  </a>
                )}
                <button
                  type="button"
                  className={styles.copyBtn}
                  onClick={() => handleCopyAudioUrl(result.arioUrl || result.permawebUrl || '')}
                >
                  {copiedAudioUrl ? 'Copied audio URL' : 'Copy audio URL'}
                </button>
              </>
            )}
            {result.txId && <p className={styles.assetId}>Tx ID: {result.txId.slice(0, 12)}…</p>}
            {result.txId && (
              <button
                type="button"
                className={styles.copyBtn}
                onClick={() => result.txId && handleCopyTxId(result.txId)}
              >
                {copiedTxId ? 'Copied' : 'Copy tx id'}
              </button>
            )}
            {appendWarning && (
              <div className={styles.warning}>
                <p className={styles.warningText}>{appendWarning}</p>
                <a
                  className={styles.warningLink}
                  href={profileLink}
                >
                  Go to profile
                </a>
              </div>
            )}
            {result.assetId && <p className={styles.assetId}>Asset ID: {result.assetId.slice(0, 12)}…</p>}
            {result.assetId ? (
              <ListOnUcm
                assetId={result.assetId}
                title={customTitle || undefined}
                defaultPriceAr="0.1"
                className={styles.ucmSuccessBlock}
              />
            ) : null}
          </div>
        )}
        {status === 'error' && errorMessage && (
          <p className={styles.error}>{errorMessage}</p>
        )}

        {stageLabel && publishStage !== 'done' && publishStage !== 'error' && (
          <div className={styles.publishStageBox} style={{ marginTop: 6 }}>
            <div className={styles.publishStageTopRow}>
              <div className={styles.publishStageTitleRow}>
                {isWaitingStage && <span className={styles.stageSpinner} aria-hidden="true" />}
                <p className={styles.publishStageTitle}>{stageLabel}</p>
              </div>
              {txIdToShow && (
                <button type="button" className={styles.copyBtn} onClick={() => handleCopyTxId(txIdToShow)}>
                  {copiedTxId ? 'Copied' : 'Copy tx id'}
                </button>
              )}
            </div>

            {coverProgress && (
              <div className={styles.progressRow}>
                <span className={styles.progressLabel}>Cover</span>
                <div className={styles.progressTrack}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${progressPct(coverProgress) ?? 0}%` }}
                    aria-hidden="true"
                  />
                </div>
                <span className={styles.progressValue}>
                  {(() => {
                    const pct = progressPct(coverProgress);
                    if (pct === null) return '…';
                    if (!isTransferStage && pct >= 100) return 'Uploaded';
                    return `${pct}%`;
                  })()}
                </span>
              </div>
            )}

            {audioProgress && (
              <div className={styles.progressRow}>
                <span className={styles.progressLabel}>Audio</span>
                <div className={styles.progressTrack}>
                  <div
                    className={styles.progressFill}
                    style={{ width: `${progressPct(audioProgress) ?? 0}%` }}
                    aria-hidden="true"
                  />
                </div>
                <span className={styles.progressValue}>
                  {(() => {
                    const pct = progressPct(audioProgress);
                    if (pct === null) return '…';
                    if (!isTransferStage && pct >= 100) return 'Uploaded';
                    return `${pct}%`;
                  })()}
                </span>
              </div>
            )}

            {(publishStage === 'confirming' || publishStage === 'waiting-gateway') && txIdToShow && (
              <div className={styles.publishStageLinks}>
                <a className={styles.link} href={arweaveTxMetaUrl(txIdToShow)} target="_blank" rel="noopener noreferrer">
                  View tx JSON
                </a>
                {permawebUrlToShow && (
                  <a className={styles.link} href={permawebUrlToShow} target="_blank" rel="noopener noreferrer">
                    Open gateway URL
                  </a>
                )}
              </div>
            )}

            {currentArtworkTxId && publishStage === 'uploading-cover' && (
              <p className={styles.hint} style={{ marginTop: 6 }}>
                Cover tx: <code>{currentArtworkTxId.slice(0, 12)}…</code>
              </p>
            )}
          </div>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={handleClose}>Cancel</button>
          <button
            type="button"
            className={`${styles.publishBtn} ${styles.publishBtnWide}`}
            onClick={handlePublish}
            disabled={isBusy || isConnecting || status === 'done'}
          >
            {primaryButtonLabel}
          </button>
        </div>

      </div>

      {/* Inline wallet chooser — full-screen overlay rendered as sibling of modal */}
      {showWalletChooser && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(10,10,20,0.92)', backdropFilter: 'blur(16px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: '14px', padding: '32px',
            zIndex: 210,
          }}
          onClick={() => setShowWalletChooser(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '14px', maxWidth: '320px', width: '100%' }}
          >
            <p style={{ fontWeight: 700, fontSize: '1.2rem', color: '#fff', marginBottom: '4px', textAlign: 'center' }}>Connect a wallet to publish</p>
            <p style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.5)', textAlign: 'center', lineHeight: 1.5, marginBottom: '8px' }}>
              Choose the wallet that matches your preferred payment method.
            </p>
            <button
              type="button"
              className={styles.publishBtn}
              style={{ width: '100%' }}
              disabled={isConnecting}
              onClick={() => connect('arweave').then(() => setShowWalletChooser(false))}
            >
              🔑 Arweave (Wander)
            </button>
            <button
              type="button"
              className={styles.publishBtn}
              style={{ width: '100%', background: 'rgba(98,126,234,0.85)' }}
              disabled={isConnecting}
              onClick={() => connect('ethereum').then(() => setShowWalletChooser(false))}
            >
              🦊 Ethereum / MetaMask
            </button>
            <button
              type="button"
              className={styles.publishBtn}
              style={{ width: '100%', background: 'rgba(20,180,130,0.85)' }}
              disabled={isConnecting}
              onClick={() => connect('solana').then(() => setShowWalletChooser(false))}
            >
              👻 Solana (Phantom)
            </button>
            <button
              type="button"
              className={styles.cancelBtn}
              style={{ marginTop: '4px' }}
              onClick={() => setShowWalletChooser(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
