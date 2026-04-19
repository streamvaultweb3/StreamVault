/**
 * Publish flows: audio data txs and optional atomic assets.
 *
 * Tag layout follows:
 * - [ANS-104](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md): UTF-8 name/value tags
 *   (≤128 tags; keys/values non-empty and bounded — enforced by gateways / @dha-team/arbundles when bundling).
 * - [ANS-110](https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-110.md) (draft): discoverable
 *   assets use `Title` + `Type` where `Type` is a category (`music`, `image`, …) — not upload format (full vs sample).
 *
 * Index of ANS docs: https://github.com/ArweaveTeam/arweave-standards/tree/master/ans
 */

import type { PublishResult } from '../lib/arweave';
import {
  arweaveDataGatewayHost,
  arweaveTxDataUrl,
  arweaveTxDataUrls,
  arweaveTxStatusUrls,
} from './arweaveDataGateway';
import type { UdlConfig, RoyaltySplit } from './udl';
import { udlConfigToTags } from './udl';
import { registerTrackOnAO } from './aoMusicRegistry';

/**
 * ANS-104 allows repeated tag names, but many gateways / GraphQL indexers assume
 * at most one `Content-Type` and duplicate names can break search or MIME routing.
 * We collapse to the first occurrence per tag name (our tag order is intentional).
 */
function dedupeArweaveTags(tags: { name: string; value: string }[]): { name: string; value: string }[] {
  const seen = new Set<string>();
  const out: { name: string; value: string }[] = [];
  for (const t of tags) {
    if (!t || typeof t.name !== 'string' || typeof t.value !== 'string') continue;
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    out.push({ name: t.name, value: t.value });
  }
  return out;
}

/** Unicode NFC so titles/artists match GraphQL text search across composed vs decomposed accents. */
function nfc(s: string): string {
  try {
    return s.normalize('NFC');
  } catch {
    return s;
  }
}

/** ANS-110 draft: Title max 150 chars. https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-110.md */
const ANS110_MAX_TITLE = 150;

/** ANS-110 `Type` for music assets (category, not upload tier). */
const ANS110_TYPE_MUSIC = 'music';
/** ANS-110 `Type` for cover artwork. */
const ANS110_TYPE_IMAGE = 'image';

function ans110Title(s: string): string {
  const t = nfc(s).trim();
  if (t.length <= ANS110_MAX_TITLE) return t;
  return t.slice(0, ANS110_MAX_TITLE);
}

interface PermawebLibs {
  createAtomicAsset?: (args: {
    name: string;
    description?: string;
    topics?: string[];
    creator: string;
    data: string;
    contentType: string;
    assetType: string;
    metadata?: Record<string, unknown>;
    tags?: { name: string; value: string }[];
  }) => Promise<string>;
}

type TurboPaymentToken = 'arweave' | 'ethereum' | 'base-eth' | 'solana' | 'base-usdc' | 'base-ario' | 'polygon-usdc' | 'pol';

interface TurboUploadOptions {
  file: Blob | File;
  tags: { name: string; value: string }[];
  paymentToken: TurboPaymentToken;
}

function describePublishError(error: unknown, context?: { useTurbo?: boolean; fromAudiusStream?: boolean }): string {
  const raw = String((error as any)?.message || error || '').trim();
  if (!raw) {
    return 'Full asset publish failed.';
  }

  if (raw === 'Failed to fetch') {
    if (context?.fromAudiusStream) {
      return 'Failed to fetch the source audio. The Audius/CDN request was blocked or unavailable. Try uploading the file from disk instead.';
    }
    if (context?.useTurbo) {
      return 'Turbo upload request failed to reach the upload service. This is usually a temporary network/service issue, not a raw AR payment issue. Retry the upload, and if it persists check your Turbo credits and wallet connection.';
    }
    return 'Upload network request failed before Arweave confirmed the file. Retry the upload.';
  }

  if (context?.useTurbo && /insufficient|balance|credit|payment/i.test(raw)) {
    return `Turbo credits/payment issue: ${raw}`;
  }

  return raw;
}

async function uploadWithTurbo(args: TurboUploadOptions): Promise<string> {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const { TurboFactory, ArconnectSigner } = await import('@ardrive/turbo-sdk/web');

  let turbo;
  if (args.paymentToken === 'arweave') {
    const wallet = win?.arweaveWallet;
    if (!wallet) throw new Error('Wander wallet required for Turbo upload.');
    const signer = new ArconnectSigner(wallet);
    turbo = TurboFactory.authenticated({ signer });
  } else if (args.paymentToken === 'solana') {
    const walletAdapter = win?.solana;
    if (!walletAdapter) throw new Error('Solana wallet required for Turbo upload.');
    turbo = TurboFactory.authenticated({ walletAdapter, token: 'solana' });
  } else {
    const provider = win?.ethereum;
    if (!provider) throw new Error('Ethereum wallet required for Turbo upload.');
    const { BrowserProvider } = await import('ethers');
    const { InjectedEthereumSigner } = await import('@dha-team/arbundles');
    const ethersProvider = new BrowserProvider(provider);
    const ethersSigner = await ethersProvider.getSigner();
    const injectedSigner = new InjectedEthereumSigner({ getSigner: () => ethersSigner as any });
    await injectedSigner.setPublicKey();
    turbo = TurboFactory.authenticated({ signer: injectedSigner as any, token: args.paymentToken });
  }

  const fileToUpload: File =
    typeof File !== 'undefined' && args.file instanceof File
      ? args.file
      : new File([args.file], 'streamvault-upload', { type: args.file.type || 'application/octet-stream' });

  console.info('[turbo] Uploading file', { size: args.file.size });
  const result = await turbo.uploadFile({
    file: fileToUpload,
    dataItemOpts: { tags: dedupeArweaveTags(args.tags) },
    events: {
      onUploadProgress: ({ totalBytes, processedBytes }) => {
        console.info('[turbo] Upload progress', { totalBytes, processedBytes });
      },
      onUploadError: (error) => {
        console.error('[turbo] Upload error', error);
      },
      onUploadSuccess: () => {
        console.info('[turbo] Upload success');
      },
    },
  });

  return result.id;
}

/**
 * Open a Stripe Checkout session to top up Turbo credits with Fiat.
 *
 * Calls the Turbo payment REST API directly to avoid pulling in the full
 * SDK import chain (which drags in rpc-websockets and other heavy deps)
 * just to generate a redirect URL. The endpoint is a simple authenticated
 * GET that returns a paymentSession.url.
 *
 * Docs: https://payment.ardrive.io/api-docs (top-up/checkout-session)
 */
export async function createFiatTopUpSession(args: {
  amountUsd: number;
  ownerAddress: string;
}): Promise<string> {

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const isLocalhost = origin.includes('localhost') || origin.includes('127.0.0.1');

  // Turbo's payment API rejects localhost URLs — use a real public URL as fallback.
  const returnBase = isLocalhost ? 'https://ardrive.io' : origin;
  const successUrl = encodeURIComponent(`${returnBase}/`);
  const cancelUrl = encodeURIComponent(`${returnBase}/`);

  // Amount is in cents — $10 = 1000
  const amountCents = Math.round(args.amountUsd * 100);

  const url =
    `https://payment.ardrive.io/v1/top-up/checkout-session/${args.ownerAddress}/usd/${amountCents}` +
    `?token=arweave&uiMode=hosted&successUrl=${successUrl}&cancelUrl=${cancelUrl}`;

  console.info('[publish] Fetching Turbo checkout session', { amountCents, owner: args.ownerAddress });

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Turbo payment API error (${res.status}): ${text}`);
  }

  const json = await res.json();
  const checkoutUrl: string | null = json?.paymentSession?.url ?? json?.url ?? null;

  if (!checkoutUrl) {
    console.error('[publish] Unexpected checkout session response', json);
    throw new Error('Turbo did not return a checkout URL. Please try again.');
  }

  return checkoutUrl;
}



/** Upload raw data transaction. Returns txId or throws. */
async function uploadDataTx(
  data: ArrayBuffer,
  contentType: string,
  tags: { name: string; value: string }[]
): Promise<string> {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const wallet = win?.arweaveWallet;
  if (!wallet) throw new Error('Wander wallet required to publish.');

  const Arweave = (await import('arweave')).default;
  const arweave = Arweave.init(arweaveDataGatewayHost());
  const tx = await arweave.createTransaction({ data: new Uint8Array(data) });
  const uniqueTags = dedupeArweaveTags(tags);
  const hasContentType = uniqueTags.some((t) => t.name === 'Content-Type');
  uniqueTags.forEach(({ name, value }) => tx.addTag(name, value));
  if (!hasContentType) {
    tx.addTag('Content-Type', contentType);
  }

  console.info('[arweave] Signing transaction', { contentType, dataBytes: data.byteLength });
  const signedTx = await wallet.sign(tx);
  const txToPost = signedTx || tx;
  console.info('[arweave] Posting transaction', { id: (txToPost as any).id || tx.id });
  const response = await arweave.transactions.post(txToPost as any);
  if (response.status >= 400) throw new Error(`Upload failed: ${response.status}`);
  const txId = (txToPost as any).id || tx.id;
  console.info('[arweave] Transaction accepted', { status: response.status, txId });
  return txId;
}

/** Upload an image to Arweave; returns gateway URL for the uploaded image. */
export async function uploadImageTx(file: Blob, tags: { name: string; value: string }[] = []): Promise<string> {
  const data = await file.arrayBuffer();
  const contentType = file.type || 'image/png';
  const txId = await uploadDataTx(
    data,
    contentType,
    dedupeArweaveTags([
      { name: 'App-Name', value: 'StreamVault' },
      { name: 'Type', value: ANS110_TYPE_IMAGE },
      ...tags,
    ])
  );
  return arweaveTxDataUrl(txId);
}

async function waitForConfirmation(txId: string, timeoutMs = 90_000): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    for (const url of arweaveTxStatusUrls(txId)) {
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (res.status === 200) return true;
      } catch {
        // ignore and try next gateway
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

async function isGatewayAudioReady(txId: string, expectedContentType?: string): Promise<boolean> {
  for (const url of arweaveTxDataUrls(txId)) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-1' },
        cache: 'no-store',
      });
      if (!(res.status === 200 || res.status === 206)) continue;
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (expectedContentType && contentType && !contentType.includes(expectedContentType.toLowerCase().split(';')[0])) {
        continue;
      }
      if (contentType.startsWith('audio/') || contentType.includes('mpeg') || contentType.includes('mp3')) {
        return true;
      }
    } catch {
      // ignore and try next gateway
    }
  }
  return false;
}

async function waitForGatewayAudioReady(
  txId: string,
  expectedContentType: string,
  timeoutMs = 120_000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await isGatewayAudioReady(txId, expectedContentType);
    if (ready) return true;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  return false;
}

/** Publish sample blob to Arweave as data tx; return permaweb link. */
export async function publishSampleToArweave(
  args: {
    sample: Blob;
    title: string;
    artist: string;
    durationSeconds: number;
    udl?: UdlConfig;
    splits?: RoyaltySplit[];
    audiusTrackId?: string;
  }
): Promise<PublishResult> {
  try {
    console.info('[publish] Sample publish started', { title: args.title, artist: args.artist });
    const data = await args.sample.arrayBuffer();
    const tags: { name: string; value: string }[] = [
      { name: 'App-Name', value: 'StreamVault' },
      { name: 'Type', value: ANS110_TYPE_MUSIC },
      { name: 'Content-Type', value: args.sample.type || 'audio/mpeg' },
      { name: 'Title', value: ans110Title(args.title) },
      { name: 'Artist', value: nfc(args.artist) },
      { name: 'Duration-Seconds', value: String(args.durationSeconds) },
    ];
    if (args.audiusTrackId) {
      tags.push({ name: 'Audius-Track-Id', value: args.audiusTrackId });
    }
    if (args.udl) {
      tags.push(...udlConfigToTags(args.udl));
    }
    if (args.splits && args.splits.length > 0) {
      tags.push({ name: 'Royalties-Splits', value: JSON.stringify(args.splits) });
    }
    const txId = await uploadDataTx(data, args.sample.type || 'audio/mpeg', dedupeArweaveTags(tags));
    const confirmed = await waitForConfirmation(txId).catch(() => false);
    const gatewayReady = await waitForGatewayAudioReady(txId, args.sample.type || 'audio/mpeg', 60_000).catch(() => false);
    const permawebUrl = arweaveTxDataUrl(txId);
    console.info('[publish] Sample publish complete', { txId, permawebUrl });
    return { success: true, txId, permawebUrl, arioUrl: arweaveTxDataUrls(txId)[1], confirmed, gatewayReady };
  } catch (e: any) {
    console.error('[publish] Sample publish failed', e);
    return { success: false, error: e?.message || 'Sample upload failed' };
  }
}

/** Publish full audio blob as atomic asset. Uploads file first, then creates asset with metadata. */
export async function publishFullAsAtomicAsset(
  args: {
    audio: Blob;
    title: string;
    artist: string;
    description?: string;
    artworkUrl?: string;
    artworkFile?: Blob;
    royaltiesBps?: number;
    udl?: UdlConfig;
    splits?: RoyaltySplit[];
    useTurbo?: boolean;
    turboPaymentToken?: TurboPaymentToken;
    /** If true, only upload the signed data tx with tags (no permaweb-libs atomic asset). */
    skipAtomicAsset?: boolean;
    audiusTrackId?: string;
    fromAudiusStream?: boolean;
  },
  creatorAddress: string,
  ctx: { libs: PermawebLibs | null }
): Promise<PublishResult> {
  const libs = ctx.libs;
  if (!args.skipAtomicAsset && !libs?.createAtomicAsset) {
    return { success: false, error: 'Atomic asset creation not available. Try “Skip atomic asset” to upload audio + UDL tags only.' };
  }

  try {
    const title = ans110Title(args.title);
    const artist = nfc(args.artist);
    console.info('[publish] Full asset publish started', { title, artist });
    const udl = args.udl;
    const splits = args.splits;
    let artworkUrlToUse = args.artworkUrl;
    if (args.artworkFile) {
      console.info('[publish] Uploading cover image to Arweave');
      artworkUrlToUse = await uploadImageTx(args.artworkFile, [
        { name: 'Title', value: title },
        { name: 'Artist', value: artist },
      ]);
    }
    let txId: string;
    let usedTurboUpload = false;
    const baseTags: { name: string; value: string }[] = [
      { name: 'App-Name', value: 'StreamVault' },
      { name: 'Type', value: ANS110_TYPE_MUSIC },
      { name: 'Content-Type', value: args.audio.type || 'audio/mpeg' },
      { name: 'Title', value: title },
      { name: 'Artist', value: artist },
      { name: 'Creator', value: creatorAddress },
    ];
    if (args.audiusTrackId) {
      baseTags.push({ name: 'Audius-Track-Id', value: args.audiusTrackId });
    }
    const desc = args.description?.trim();
    if (desc) {
      baseTags.push({ name: 'Description', value: nfc(desc).slice(0, 300) });
    }

    if (udl) {
      baseTags.push(...udlConfigToTags(udl));
    }

    if (splits && splits.length > 0) {
      baseTags.push({ name: 'Royalties-Splits', value: JSON.stringify(splits) });
    }

    const confirmTimeoutMs = Math.min(
      180_000,
      Math.max(60_000, Math.floor((args.audio.size / (1024 * 1024)) * 30_000) + 45_000)
    );

    if (args.useTurbo) {
      try {
        txId = await uploadWithTurbo({
          file: args.audio,
          tags: dedupeArweaveTags(baseTags),
          paymentToken: args.turboPaymentToken || 'arweave',
        });
        usedTurboUpload = true;
      } catch (e: any) {
        const msg = String(e?.message || e || '');
        const isGatewayIssue =
          msg.includes('getPrice') ||
          msg.includes('Bad Gateway') ||
          msg.includes('502') ||
          msg.includes('Website is offline');
        if (isGatewayIssue && args.audio.size <= 10 * 1024 * 1024) {
          // Fallback: try direct Arweave upload so creators can still publish when Turbo is down.
          const data = await args.audio.arrayBuffer();
          txId = await uploadDataTx(
            data,
            args.audio.type || 'audio/mpeg',
            dedupeArweaveTags(baseTags)
          );
        } else {
          throw e;
        }
      }
    } else {
      const data = await args.audio.arrayBuffer();
      if (data.byteLength > 10 * 1024 * 1024) return { success: false, error: 'File too large (max ~10MB).' };

      txId = await uploadDataTx(
        data,
        args.audio.type || 'audio/mpeg',
        dedupeArweaveTags(baseTags)
      );
    }
    let confirmed = false;
    if (usedTurboUpload) {
      // Turbo returns a data item id that is immediately usable as a gateway URL,
      // but `/tx/<id>/status` is not a reliable confirmation endpoint for that id.
      // Treat Turbo upload success as accepted and verify availability via data URL probing instead.
      confirmed = true;
      console.info('[publish] Turbo upload accepted; skipping raw tx status polling', { txId });
    } else {
      console.info('[publish] Waiting for L1 confirmation (GraphQL discovery is usually post-confirmation)', {
        txId,
        confirmTimeoutMs,
      });
      confirmed = await waitForConfirmation(txId, confirmTimeoutMs).catch(() => false);
    }
    const gatewayReadyTimeoutMs = Math.min(
      240_000,
      Math.max(90_000, Math.floor((args.audio.size / (1024 * 1024)) * 45_000) + 60_000)
    );
    console.info('[publish] Waiting for gateway audio availability', {
      txId,
      gatewayReadyTimeoutMs,
    });
    const gatewayReady = await waitForGatewayAudioReady(
      txId,
      args.audio.type || 'audio/mpeg',
      gatewayReadyTimeoutMs
    ).catch(() => false);
    const permawebUrl = arweaveTxDataUrl(txId);

    if (args.skipAtomicAsset) {
      try {
        await registerTrackOnAO({
          assetId: txId,
          audioTxId: txId,
          creator: creatorAddress,
          udl,
          splits,
          tags: {
            Title: title,
            Artist: artist,
            Source: 'streamvault-data-tx',
          },
        });
      } catch (e) {
        console.warn('[publish] Failed to register data-tx track on AO', e);
      }
      return {
        success: true,
        txId,
        assetId: undefined,
        permawebUrl,
        arioUrl: arweaveTxDataUrls(txId)[1],
        confirmed,
        gatewayReady,
      };
    }

    if (!libs?.createAtomicAsset) {
      return { success: false, error: 'Atomic asset creation not available.' };
    }

    const metadata: Record<string, unknown> = {
      audioTxId: txId,
      artist,
      artwork: artworkUrlToUse || undefined,
      royaltiesBps: args.royaltiesBps ?? undefined,
    };
    if (udl) metadata.udl = udl;
    if (splits && splits.length > 0) metadata.splits = splits;

    const assetTags: { name: string; value: string }[] = [
      { name: 'App-Name', value: 'StreamVault' },
      { name: 'Type', value: ANS110_TYPE_MUSIC },
      { name: 'Title', value: title },
      { name: 'Track-AudioTx', value: txId },
      { name: 'Artist', value: artist },
      { name: 'Creator', value: creatorAddress },
    ];

    if (udl) {
      assetTags.push(...udlConfigToTags(udl));
    }

    if (splits && splits.length > 0) {
      assetTags.push({ name: 'Royalties-Splits', value: JSON.stringify(splits) });
    }

    const assetId = await libs.createAtomicAsset({
      name: title,
      description: args.description || `Permanent release by ${artist}`,
      topics: ['Music', 'StreamVault', 'Atomic-Asset'],
      creator: creatorAddress,
      data: permawebUrl,
      contentType: 'text/plain',
      assetType: 'audio',
      metadata,
      tags: dedupeArweaveTags(assetTags),
    });

    console.info('[publish] Full asset publish complete', { txId, assetId, permawebUrl });

    // Best-effort AO registration for discovery and royalty engine usage.
    try {
      await registerTrackOnAO({
        assetId,
        audioTxId: txId,
        creator: creatorAddress,
        udl,
        splits,
        tags: {
          Title: title,
          Artist: artist,
        },
      });
    } catch (e) {
      console.warn('[publish] Failed to register track on AO MusicRegistry', e);
    }
    return {
      success: true,
      txId,
      assetId,
      permawebUrl,
      arioUrl: arweaveTxDataUrls(txId)[1],
      confirmed,
      gatewayReady,
    };
  } catch (e: any) {
    console.error('[publish] Full asset publish failed', e);
    return {
      success: false,
      error: describePublishError(e, {
        useTurbo: args.useTurbo,
        fromAudiusStream: args.fromAudiusStream,
      }),
    };
  }
}
