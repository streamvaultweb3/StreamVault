import { useEffect, useState } from 'react';
import type { Track } from '../context/PlayerContext';
import { usePermaweb } from '../context/PermawebContext';
import { useWallet } from '../context/WalletContext';
import { useGeneratedCover } from '../context/GeneratedCoverContext';
import { useGeneratedAudio } from '../context/GeneratedAudioContext';
import { type PublishResult } from '../lib/arweave';
import { getSelectedOrLatestProfileByWallet } from '../lib/permaProfile';
import { fetchAudiusStreamAsBlob } from '../lib/audius';
import { arweaveTxMetaUrl } from '../lib/arweaveDataGateway';
import { publishFullAsAtomicAsset, createFiatTopUpSession } from '../lib/publish';
import { fetchTurboBalance, formatTurboCredits, type TurboBalance } from '../lib/turboCredits';
import { fetchL1CostForBytes, fetchTurboCostForBytes, formatArFromWinston } from '../lib/uploadCosts';
import { appendUploadLedger } from '../lib/uploadLedger';
import type { UdlConfig, RoyaltySplit, UdlAiUse } from '../lib/udl';
import { udlToSummary } from '../lib/uploadedTracks';
import styles from './PublishModal.module.css';

interface PublishModalProps {
  track?: Track;
  onClose: () => void;
  onSuccess?: (result: PublishResult) => void;
}

export function PublishModal({ track, onClose, onSuccess }: PublishModalProps) {
  const { libs } = usePermaweb();
  const { address, walletType, connect, isConnecting } = useWallet();
  const { generatedCover, clearGeneratedCover } = useGeneratedCover();
  const { generatedAudio, clearGeneratedAudio } = useGeneratedAudio();
  const isAudiusBackedTrack = Boolean(track?.streamUrl && !track?.isPermanent && !track?.permaTxId && !track?.assetId);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'confirming' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<PublishResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fullFile, setFullFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [royaltiesBps, setRoyaltiesBps] = useState<number>(500);
  const [useTurbo, setUseTurbo] = useState(true);
  const [turboToken, setTurboToken] = useState<'arweave' | 'ethereum' | 'base-eth' | 'solana' | 'base-usdc' | 'base-ario' | 'polygon-usdc' | 'pol'>('arweave');
  const [showAdvancedUpload, setShowAdvancedUpload] = useState(false);
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
  /** Upload signed data tx with UDL tags only; skip permaweb-libs createAtomicAsset (HyperBEAM / SU issues). */
  const [skipAtomicAsset, setSkipAtomicAsset] = useState(false);

  // Simple UDL controls
  const [licenseUsePreset, setLicenseUsePreset] = useState<'stream' | 'stream-download' | 'stream-download-commercial'>('stream');
  const [aiUse, setAiUse] = useState<UdlAiUse>('deny');
  const [licenseFee, setLicenseFee] = useState<string>('0');
  const [licenseCurrency, setLicenseCurrency] = useState<string>('MATIC');

  // New states for global upload where track is undefined
  const [customTitle, setCustomTitle] = useState(track?.title || '');
  const [customArtist, setCustomArtist] = useState(track?.artist || '');

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
    if (!address || !walletType || !libs) {
      // Show inline wallet chooser instead of a plain error
      setShowWalletChooser(true);
      return;
    }
    setStatus('uploading');
    setErrorMessage(null);
    setAppendWarning(null);
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
        setErrorMessage(
          'Choose an audio file, enable “Use Audius stream as full audio” if this track is playing from Audius, or generate a beat in Creator tools and use “Use in Publish”.'
        );
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
          setErrorMessage('Connect the matching wallet for the selected Turbo payment option.');
          return;
        }
      } else if (walletType !== 'arweave') {
        setStatus('error');
        setErrorMessage('Connect Wander (Arweave) for non-Turbo full uploads.');
        return;
      }
      if (!useTurbo && effectiveAudio.size > 10 * 1024 * 1024) {
        setStatus('error');
        setErrorMessage('Full asset must be under ~10MB unless using Turbo.');
        return;
      }
      const udlConfig = buildUdlConfig();
      const splits = buildDefaultSplits();

      const res: PublishResult = await publishFullAsAtomicAsset(
        {
          audio: effectiveAudio,
          title: customTitle || 'Unknown Track',
          artist: customArtist || 'Unknown Artist',
          description: description.trim() || undefined,
          artworkUrl: (coverFile || generatedCover) ? undefined : track?.artwork,
          artworkFile: (coverFile || generatedCover) || undefined,
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
        { libs }
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
            audiusTrackId: track?.streamUrl ? String(track.id) : undefined,
            description: description.trim() || undefined,
            artworkUrl:
              typeof track?.artwork === 'string' && track.artwork.trim()
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
    } catch (e: any) {
      console.error('[publish] Publish failed', e);
      setResult({ success: false, error: e?.message || 'Publish failed' });
      setErrorMessage(e?.message || 'Publish failed');
      setStatus('error');
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal + ' glass-strong'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>Publish to Arweave</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className={styles.subtitle}>Upload the full track with Turbo-backed delivery, your license (UDL), and optional atomic asset.</p>
        {status === 'uploading' && (
          <p className={styles.hint}>Uploading full audio to Arweave…</p>
        )}

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
          <>
              <label className={styles.label}>
                Full audio file (up to ~10MB without Turbo, larger with Turbo)
                <input
                  className={styles.file}
                  type="file"
                  accept="audio/*"
                  onChange={(e) => setFullFile(e.target.files?.[0] || null)}
                />
              </label>
              {(estimatedByteCount || costEstimateLoading || costEstimateError || turboCostEstimate !== null || l1CostEstimate !== null) && (
                <div className={styles.turboBalanceBox}>
                  <span className={styles.turboBalanceLabel}>Estimated upload cost</span>
                  {estimatedByteCount ? (
                    <span className={styles.hint} style={{ marginTop: 0 }}>
                      Based on {(estimatedByteCount / (1024 * 1024)).toFixed(2)} MB of local audio data.
                    </span>
                  ) : (
                    <span className={styles.hint} style={{ marginTop: 0 }}>
                      Cost estimate appears after selecting a local file or generated audio. Remote Audius streams are estimated only after fetch.
                    </span>
                  )}
                  {costEstimateLoading ? (
                    <strong className={styles.turboBalanceValue}>Loading estimates…</strong>
                  ) : (
                    <>
                      {turboCostEstimate !== null && (
                        <strong className={styles.turboBalanceValue}>
                          Turbo: {formatTurboCredits(turboCostEstimate)}
                        </strong>
                      )}
                      {l1CostEstimate !== null && (
                        <strong className={styles.turboBalanceValue}>
                          Direct L1: {formatArFromWinston(l1CostEstimate)}
                        </strong>
                      )}
                    </>
                  )}
                  {costEstimateError && <span className={styles.turboBalanceError}>{costEstimateError}</span>}
                </div>
              )}
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
                  checked={skipAtomicAsset}
                  onChange={(e) => setSkipAtomicAsset(e.target.checked)}
                />
                <span>Skip atomic asset — upload audio with UDL tags only (no permaweb-libs mint).</span>
              </label>
              {generatedAudio && !fullFile && (
                <p className={styles.generatedCoverNote}>
                  Using generated beat from Creator tools.{' '}
                  <button type="button" className={styles.clearGeneratedBtn} onClick={clearGeneratedAudio}>
                    Clear
                  </button>
                </p>
              )}
              <label className={styles.label}>
                Cover image (optional)
                <input
                  className={styles.file}
                  type="file"
                  accept="image/*"
                  onChange={(e) => setCoverFile(e.target.files?.[0] || null)}
                />
              </label>
              {generatedCover && !coverFile && (
                <p className={styles.generatedCoverNote}>
                  Using generated cover from Creator tools.{' '}
                  <button type="button" className={styles.clearGeneratedBtn} onClick={clearGeneratedCover}>
                    Clear
                  </button>
                </p>
              )}
              <p className={styles.hint}>
                Upload an image, or{' '}
                <a href="#/creator-tools" className={styles.creatorToolsLink}>
                  generate cover art in the browser
                </a>
                {' '}(layers + composite).
              </p>
              <label className={styles.label}>
                Description (optional)
                <textarea
                  className={styles.textarea}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Release notes, credits, intent…"
                />
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
              <div style={{ marginTop: '8px', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                <p className={styles.hint} style={{ margin: '0 0 8px 0' }}>
                  Full-track uploads use Turbo by default for more reliable delivery and availability than direct L1 posting.
                </p>
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={showAdvancedUpload}
                    onChange={(e) => setShowAdvancedUpload(e.target.checked)}
                  />
                  <span>Show advanced upload options</span>
                </label>
                {showAdvancedUpload && (
                  <label className={styles.checkLabel}>
                    <input
                      type="checkbox"
                      checked={!useTurbo}
                      onChange={(e) => setUseTurbo(!e.target.checked)}
                    />
                    <span>Use direct Arweave L1 upload instead of Turbo (fallback only)</span>
                  </label>
                )}
              </div>
              {useTurbo && (
                <label className={styles.label}>
                  Upload payment
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
                <div className={styles.turboPanel}>
                  <p className={styles.turboPanelHint}>
                    Pay for Arweave uploads with Turbo credits. You can buy Turbo credits with a credit card through Stripe, then spend those credits on uploads.
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
                    <button
                      type="button"
                      className={styles.turboActionBtn}
                      onClick={openTurboTopUp}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className={styles.turboActionBtn}
                      onClick={openTurboPricingCalculator}
                    >
                      Size Calculator
                    </button>
                  </div>
                  <p className={styles.turboPanelHint}>
                    Current publish path: <strong>Turbo credits</strong>{' '}
                    {turboToken === 'arweave' ? 'with your Arweave wallet balance/credits' : `via ${turboToken}`}.
                    Raw AR is only used when you enable the direct L1 fallback.
                  </p>
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
                </div>
              )}
              <p className={styles.hint}>
                {useTurbo
                  ? 'Turbo uploads use credits instead of paying raw AR for each upload.'
                  : 'Direct Arweave L1 upload is fallback-only and may take longer to become streamable from gateways.'}
              </p>
              <p className={styles.hint}>
                Royalties are stored in standard metadata for future distribution/DEX integration.
              </p>
          </>
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
                This upload used <strong>Turbo credits</strong>{' '}
                {turboToken === 'arweave' ? 'through your connected Arweave wallet' : `via ${turboToken}`},
                not a direct raw-AR L1 post.
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
                  href={address ? `/#/profile/${address}` : '/#/profile'}
                >
                  Go to profile
                </a>
              </div>
            )}
            {result.assetId && <p className={styles.assetId}>Asset ID: {result.assetId.slice(0, 12)}…</p>}
          </div>
        )}
        {status === 'error' && errorMessage && (
          <p className={styles.error}>{errorMessage}</p>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className={styles.publishBtn}
            onClick={handlePublish}
            disabled={status === 'uploading' || status === 'confirming' || isConnecting}
          >
            {status === 'uploading' || status === 'confirming'
              ? 'Publishing…'
              : status === 'done'
                ? 'Done'
                : !address
                  ? 'Connect wallet to publish'
                  : 'Publish to Arweave'}
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
