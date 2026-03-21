import { useState } from 'react';
import type { Track } from '../context/PlayerContext';
import { usePermaweb } from '../context/PermawebContext';
import { useWallet } from '../context/WalletContext';
import { useGeneratedCover } from '../context/GeneratedCoverContext';
import { useGeneratedAudio } from '../context/GeneratedAudioContext';
import {
  PublishTier,
  type PublishResult,
} from '../lib/arweave';
import { getSelectedOrLatestProfileByWallet } from '../lib/permaProfile';
import { publishSampleToArweave, publishFullAsAtomicAsset, publishFullDirectToArweave, createFiatTopUpSession } from '../lib/publish';
import type { UdlConfig, RoyaltySplit, UdlAiUse } from '../lib/udl';
import { trackEvent } from '../lib/analytics';
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
  const [tier, setTier] = useState<PublishTier>(track ? 'sample' : 'full');
  const [status, setStatus] = useState<'idle' | 'uploading' | 'confirming' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<PublishResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sampleFile, setSampleFile] = useState<Blob | null>(null);
  const [fullFile, setFullFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [royaltiesBps, setRoyaltiesBps] = useState<number>(500);
  const [fullPublishMode, setFullPublishMode] = useState<'direct' | 'atomic'>('direct');
  const [useTurbo, setUseTurbo] = useState(false);
  const [turboToken, setTurboToken] = useState<'arweave' | 'ethereum' | 'base-eth' | 'solana' | 'base-usdc' | 'base-ario' | 'polygon-usdc' | 'pol'>('arweave');
  const [isAutoSample, setIsAutoSample] = useState(true);
  const [copiedTxId, setCopiedTxId] = useState(false);
  const [appendWarning, setAppendWarning] = useState<string | null>(null);
  const [fiatAmount, setFiatAmount] = useState<string>('10');
  const [isTopUpLoading, setIsTopUpLoading] = useState(false);
  const [showWalletChooser, setShowWalletChooser] = useState(false);

  // Simple UDL controls
  const [licenseUsePreset, setLicenseUsePreset] = useState<'stream' | 'stream-download' | 'stream-download-commercial'>('stream');
  const [aiUse, setAiUse] = useState<UdlAiUse>('deny');
  const [licenseFee, setLicenseFee] = useState<string>('0');
  const [licenseCurrency, setLicenseCurrency] = useState<string>('MATIC');

  // New states for global upload where track is undefined
  const [customTitle, setCustomTitle] = useState(track?.title || '');
  const [customArtist, setCustomArtist] = useState(track?.artist || '');

  const SAMPLE_MAX_BYTES = 100 * 1024;

  const handleCopyTxId = async (txId: string) => {
    try {
      await navigator.clipboard.writeText(txId);
      setCopiedTxId(true);
      window.setTimeout(() => setCopiedTxId(false), 1500);
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
      trackEvent('turbo_top_up_attempt', {
        amount_usd: amount,
      });
      setIsTopUpLoading(true);
      setErrorMessage(null);
      const url = await createFiatTopUpSession({ amountUsd: amount, ownerAddress: address });
      trackEvent('turbo_top_up_redirected', { amount_usd: amount });
      window.location.href = url;
    } catch (e: any) {
      trackEvent('turbo_top_up_failed', {
        reason: String(e?.message || 'top_up_error').slice(0, 200),
      });
      setErrorMessage(e?.message || 'Failed to initialize Stripe checkout.');
    } finally {
      setIsTopUpLoading(false);
    }
  };

  const fetchSampleFromStream = async (streamUrl: string, maxBytes = SAMPLE_MAX_BYTES) => {
    const res = await fetch(streamUrl, {
      headers: { Range: `bytes=0-${maxBytes - 1}` },
    });
    if (!res.ok) throw new Error('Unable to fetch a sample from the stream.');
    const contentType = res.headers.get('content-type') || 'audio/mpeg';
    if (!contentType.startsWith('audio/')) {
      throw new Error('Stream did not return audio data.');
    }
    const data = await res.arrayBuffer();
    return new Blob([data.slice(0, maxBytes)], { type: contentType });
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
    // #region agent log
    fetch('http://127.0.0.1:7939/ingest/0b5e774a-21c9-48b0-b426-076405dcd7ec',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'935ac8'},body:JSON.stringify({sessionId:'935ac8',runId:'pre-fix',hypothesisId:'P1',location:'src/components/PublishModal.tsx:157',message:'handlePublish-start',data:{tier,walletType,hasAddress:Boolean(address),useTurbo,isAutoSample,hasSampleFile:Boolean(sampleFile),hasFullFile:Boolean(fullFile),audioFromGenerator:Boolean(generatedAudio)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion agent log
    if (!address || !walletType || !libs) {
      // Show inline wallet chooser instead of a plain error
      trackEvent('publish_blocked_wallet_required', {
        tier,
      });
      setShowWalletChooser(true);
      return;
    }
    trackEvent('publish_attempt', {
      tier,
      wallet_type: walletType,
      use_turbo: useTurbo,
      turbo_token: useTurbo ? turboToken : 'none',
      has_cover: Boolean(coverFile || generatedCover || track?.artwork),
    });
    setStatus('uploading');
    setErrorMessage(null);
    setAppendWarning(null);
    try {
      let res: PublishResult;
      if (tier === 'sample') {
        if (walletType !== 'arweave') {
          setStatus('error');
          setErrorMessage('Connect Wander (Arweave) to publish samples permanently.');
          return;
        }
        let sample = sampleFile;
        if (!sample && isAutoSample && track?.streamUrl) {
          sample = await fetchSampleFromStream(track.streamUrl);
        }
        if (!sample) {
          setStatus('error');
          setErrorMessage('Upload a short sound bite under 100KB or use auto-sample (if viewing a track).');
          return;
        }
        if (sample.type && !sample.type.startsWith('audio/')) {
          setStatus('error');
          setErrorMessage('Sample must be an audio file.');
          return;
        }
        if (sample.size > SAMPLE_MAX_BYTES) {
          setStatus('error');
          setErrorMessage('Sample must be under 100KB. Try exporting a smaller MP3/OPUS.');
          return;
        }
        res = await publishSampleToArweave({
          sample,
          title: `${customTitle || 'Unknown Track'} (15s sample)`,
          artist: customArtist || 'Unknown Artist',
          durationSeconds: 15,
        });
      } else {
        const effectiveAudio = fullFile || (generatedAudio ? new File([generatedAudio], 'generated-beat.wav', { type: 'audio/wav' }) : null);
        if (!effectiveAudio) {
          setStatus('error');
          setErrorMessage('Choose an audio file to publish as an Atomic Asset, or generate a beat in Creator tools and use "Use in Publish".');
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

        if (fullPublishMode === 'direct') {
          res = await publishFullDirectToArweave(
            {
              audio: effectiveAudio,
              title: customTitle || 'Unknown Track',
              artist: customArtist || 'Unknown Artist',
              description: description.trim() || undefined,
              artworkUrl: (coverFile || generatedCover) ? undefined : track?.artwork,
              artworkFile: (coverFile || generatedCover) || undefined,
              udl: udlConfig,
              splits,
              useTurbo,
              turboPaymentToken: turboToken,
            },
            address
          );
        } else {
          res = await publishFullAsAtomicAsset(
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
            },
            address,
            { libs }
          );
        }
      }
      if (res.success && tier === 'full') {
        clearGeneratedCover();
        clearGeneratedAudio();
      }
      trackEvent(res.success ? 'publish_success' : 'publish_failed', {
        tier,
        wallet_type: walletType || 'unknown',
        use_turbo: useTurbo,
        tx_id_present: Boolean(res.txId),
        error: res.error ? String(res.error).slice(0, 200) : undefined,
      });
      setResult(res);
      setStatus(res.success ? 'done' : 'error');
      if (res.error) setErrorMessage(res.error);
      console.info('[publish] Result', res);
      if (res.success && res.txId && address) {
        try {
          if (walletType === 'arweave' && libs?.addToZone) {
            const profile = await getSelectedOrLatestProfileByWallet(libs, address);
            if (profile?.id) {
              const zonePath = tier === 'full' ? 'Tracks[]' : 'Samples[]';
              await libs.addToZone(
                {
                  path: zonePath,
                  data: {
                    txId: res.txId,
                    kind: tier === 'full' ? 'full-track' : 'sample',
                    title: customTitle || 'Unknown Track',
                    artist: customArtist || 'Unknown Artist',
                    source: track ? 'audius' : 'streamvault',
                    sourceTrackId: track?.id || null,
                    sourceArtistId: track?.artistId || null,
                    permawebUrl: res.permawebUrl,
                    arioUrl: res.arioUrl,
                    createdAt: new Date().toISOString(),
                  },
                },
                profile.id
              );
            } else {
              setAppendWarning('Create a permaweb profile to store this on-chain.');
            }
          } else if (walletType === 'arweave') {
            setAppendWarning('Permaweb profile tools are not ready yet. Try again later.');
          }
          const key = `streamvault:${tier === 'full' ? 'tracks' : 'samples'}:${address.toLowerCase()}`;
          const existing = JSON.parse(localStorage.getItem(key) || '[]') as Array<Record<string, any>>;
          const entry = {
            txId: res.txId,
            kind: tier === 'full' ? 'full-track' : 'sample',
            title: customTitle || 'Unknown Track',
            artist: customArtist || 'Unknown Artist',
            source: track ? 'audius' : 'streamvault',
            sourceTrackId: track?.id || null,
            permawebUrl: res.permawebUrl,
            arioUrl: res.arioUrl,
            createdAt: new Date().toISOString(),
          };
          localStorage.setItem(key, JSON.stringify([entry, ...existing].slice(0, 50)));
        } catch (e) {
          console.warn('[publish] Failed to persist local record', e);
          setAppendWarning('Upload saved locally only. Create a permaweb profile to store it on-chain.');
        }
      }
      if (res.success && onSuccess) onSuccess(res);
    } catch (e: any) {
      console.error('[publish] Publish failed', e);
      trackEvent('publish_failed', {
        tier,
        wallet_type: walletType || 'unknown',
        use_turbo: useTurbo,
        reason: String(e?.message || 'publish_error').slice(0, 200),
      });
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
        <p className={styles.subtitle}>Creator-first: choose how to preserve this track permanently.</p>
        {status === 'uploading' && (
          <p className={styles.hint}>
            {tier === 'sample'
              ? 'Uploading sample to Arweave…'
              : 'Uploading audio completely on-chain…'}
          </p>
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

        <div className={styles.tiers}>
          {track && (
            <label className={styles.tierCard + (tier === 'sample' ? ' ' + styles.tierActive : '')}>
              <input type="radio" name="tier" checked={tier === 'sample'} onChange={() => setTier('sample')} />
              <span className={styles.tierTitle}>Sample — Free</span>
              <span className={styles.tierDesc}>15s preview · Under 100KB · Permanent link · Collectible in-app</span>
            </label>
          )}
          <label className={styles.tierCard + (tier === 'full' ? ' ' + styles.tierActive : '')}>
            <input type="radio" name="tier" checked={tier === 'full'} onChange={() => setTier('full')} />
            <span className={styles.tierTitle}>Full — Permanent Audio</span>
            <span className={styles.tierDesc}>Up to ~10MB · Metadata, artwork, royalties · Full quality audio</span>
          </label>
        </div>

        <div className={styles.form}>
          {tier === 'sample' ? (
            <>
              <label className={styles.label}>
                Sample sound bite (under 100KB)
                <input
                  className={styles.file}
                  type="file"
                  accept="audio/*"
                  onChange={(e) => setSampleFile(e.target.files?.[0] || null)}
                />
              </label>
              {track?.streamUrl && (
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={isAutoSample}
                    onChange={(e) => setIsAutoSample(e.target.checked)}
                  />
                  <span>Auto-sample from the track stream when available.</span>
                </label>
              )}
              <p className={styles.hint}>
                Tip: export a short MP3 clip to hit the free tier target.
              </p>
            </>
          ) : (
            <>
              <label className={styles.label}>
                Full audio file (up to ~10MB)
                <input
                  className={styles.file}
                  type="file"
                  accept="audio/*"
                  onChange={(e) => setFullFile(e.target.files?.[0] || null)}
                />
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
              <div className={styles.licenseBlock}>
                <p className={styles.licenseTitle}>Publish mode</p>
                <label className={styles.checkLabel}>
                  <input
                    type="radio"
                    name="full-publish-mode"
                    checked={fullPublishMode === 'direct'}
                    onChange={() => setFullPublishMode('direct')}
                  />
                  <span>Direct Arweave upload with StreamVault music tags. Recommended for now.</span>
                </label>
                <label className={styles.checkLabel}>
                  <input
                    type="radio"
                    name="full-publish-mode"
                    checked={fullPublishMode === 'atomic'}
                    onChange={() => setFullPublishMode('atomic')}
                  />
                  <span>Atomic Asset on AO mainnet. Experimental until the spawn path is stable.</span>
                </label>
              </div>
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
                  These values are stored on-chain in the Universal Data License (UDL) fields for this track.
                </p>
              </div>
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={useTurbo}
                  onChange={(e) => setUseTurbo(e.target.checked)}
                />
                <span>Use Turbo paid upload (credits/AR). Recommended for files over 10MB.</span>
              </label>
              {useTurbo && (
                <label className={styles.label}>
                  Turbo payment
                  <select
                    className={styles.select}
                    value={turboToken}
                    onChange={(e) => setTurboToken(e.target.value as typeof turboToken)}
                  >
                    <option value="arweave">Arweave (Wander)</option>
                    <option value="ethereum">Ethereum (ETH wallet)</option>
                    <option value="base-eth">Base (ETH wallet)</option>
                    <option value="solana">Solana (Phantom)</option>
                    <option value="base-usdc">Base (USDC)</option>
                    <option value="base-ario">Base (ARIO)</option>
                    <option value="polygon-usdc">Polygon (USDC)</option>
                    <option value="pol">Polygon (POL)</option>
                  </select>
                </label>
              )}
              {useTurbo && (
                <div style={{ marginTop: '8px', padding: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px' }}>
                  <p className={styles.hint} style={{ margin: '0 0 8px 0' }}>Need Turbo credits? Top up with a credit card.</p>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
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
                      {isTopUpLoading ? 'Loading…' : 'Buy Credits'}
                    </button>
                  </div>
                </div>
              )}
              <p className={styles.hint}>
                Turbo uses the selected wallet for payment and credits.
              </p>
              <p className={styles.hint}>
                {fullPublishMode === 'direct'
                  ? 'Direct mode uploads the track as an ANS-104 DataItem via Turbo or a standard Arweave transaction, with StreamVault music tags for discovery.'
                  : 'Royalties are stored in standard metadata for future distribution and AO-based atomic asset flows.'}
              </p>
            </>
          )}
        </div>

        {status === 'done' && result?.success && (
          <div className={styles.success}>
            <span className={styles.successBadge}>Permanent</span>
            {result.confirmed === false && (
              <span className={styles.pendingBadge}>Pending</span>
            )}
            <p className={styles.successText}>Upload complete. Your sound bite is now on-chain.</p>
            {result.permawebUrl && (
              <a href={result.permawebUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
                View on permaweb
              </a>
            )}
            {result.arioUrl && (
              <a href={result.arioUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
                View on ar.io
              </a>
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
                  : `Publish ${tier === 'sample' ? 'sample' : fullPublishMode === 'direct' ? 'full track' : 'full asset'}`}
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
              onClick={() =>
                connect('arweave')
                  .then((addr) => {
                    trackEvent('publish_wallet_connect_success', {
                      wallet_type: 'arweave',
                      address_prefix: addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'unknown',
                    });
                    setShowWalletChooser(false);
                  })
                  .catch((e: any) => {
                    trackEvent('publish_wallet_connect_failed', {
                      wallet_type: 'arweave',
                      reason: String(e?.message || 'connect_error').slice(0, 200),
                    });
                    setErrorMessage(String(e?.message || 'Failed to connect Arweave wallet.'));
                  })
              }
            >
              🔑 Arweave (Wander)
            </button>
            <button
              type="button"
              className={styles.publishBtn}
              style={{ width: '100%', background: 'rgba(98,126,234,0.85)' }}
              disabled={isConnecting}
              onClick={() =>
                connect('ethereum')
                  .then(() => {
                    trackEvent('publish_wallet_connect_success', {
                      wallet_type: 'ethereum',
                    });
                    setShowWalletChooser(false);
                  })
                  .catch((e: any) => {
                    trackEvent('publish_wallet_connect_failed', {
                      wallet_type: 'ethereum',
                      reason: String(e?.message || 'connect_error').slice(0, 200),
                    });
                    setErrorMessage(String(e?.message || 'Failed to connect Ethereum wallet.'));
                  })
              }
            >
              🦊 Ethereum / MetaMask
            </button>
            <button
              type="button"
              className={styles.publishBtn}
              style={{ width: '100%', background: 'rgba(20,180,130,0.85)' }}
              disabled={isConnecting}
              onClick={() =>
                connect('solana')
                  .then(() => {
                    trackEvent('publish_wallet_connect_success', {
                      wallet_type: 'solana',
                    });
                    setShowWalletChooser(false);
                  })
                  .catch((e: any) => {
                    trackEvent('publish_wallet_connect_failed', {
                      wallet_type: 'solana',
                      reason: String(e?.message || 'connect_error').slice(0, 200),
                    });
                    setErrorMessage(String(e?.message || 'Failed to connect Solana wallet.'));
                  })
              }
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
