/**
 * Publish flows: sample (data tx, <100kb) and full (atomic asset with metadata).
 * Uses Arweave wallet for signing and permaweb-libs for atomic assets.
 */

import type { PublishResult } from '../lib/arweave';
import type { UdlConfig, RoyaltySplit } from './udl';
import { registerTrackOnAO } from './aoMusicRegistry';

const GATEWAY = 'https://arweave.net';
const AR_IO_GATEWAY = 'https://ar-io.net';

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

interface FullAudioUploadArgs {
  audio: Blob;
  title: string;
  artist: string;
  creatorAddress: string;
  useTurbo?: boolean;
  turboPaymentToken?: TurboPaymentToken;
  udl?: UdlConfig;
  splits?: RoyaltySplit[];
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
  // #region agent log
  fetch('http://127.0.0.1:7939/ingest/0b5e774a-21c9-48b0-b426-076405dcd7ec',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'935ac8'},body:JSON.stringify({sessionId:'935ac8',runId:'pre-fix',hypothesisId:'H1',location:'src/lib/publish.ts:66',message:'turbo-upload-start',data:{paymentToken:args.paymentToken,fileSize:args.file.size},timestamp:Date.now()})}).catch(()=>{});
  // #endregion agent log
  const result = await turbo.uploadFile({
    file: fileToUpload,
    dataItemOpts: { tags: args.tags },
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

function buildFullAudioTags(args: FullAudioUploadArgs): { name: string; value: string }[] {
  const tags: { name: string; value: string }[] = [
    { name: 'App-Name', value: 'StreamVault' },
    { name: 'App-Version', value: '1.0.0' },
    { name: 'Protocol', value: 'StreamVault' },
    { name: 'Data-Protocol', value: 'StreamVault' },
    { name: 'Type', value: 'audio-full' },
    { name: 'Content-Type', value: args.audio.type || 'audio/mpeg' },
    { name: 'Title', value: args.title },
    { name: 'Artist', value: args.artist },
    { name: 'Creator', value: args.creatorAddress },
    { name: 'Upload-Type', value: args.useTurbo ? 'turbo-ans104' : 'arweave-transaction' },
    { name: 'Unix-Time', value: String(Date.now()) },
  ];

  if (args.udl) {
    tags.push(
      { name: 'License', value: args.udl.licenseId },
      ...(args.udl.uri ? [{ name: 'License-URI', value: args.udl.uri }] : []),
      { name: 'License-Use', value: args.udl.usage.join(',') },
      { name: 'License-AI-Use', value: args.udl.aiUse },
      { name: 'License-Fee', value: args.udl.fee },
      { name: 'License-Fee-Unit', value: args.udl.interval },
      { name: 'License-Currency', value: args.udl.currency },
      ...(args.udl.attribution ? [{ name: 'License-Attribution', value: args.udl.attribution }] : []),
      ...(args.udl.jurisdiction ? [{ name: 'License-Jurisdiction', value: args.udl.jurisdiction }] : []),
    );
  }

  if (args.splits && args.splits.length > 0) {
    tags.push({ name: 'Royalties-Splits', value: JSON.stringify(args.splits) });
  }

  return tags;
}

async function uploadFullAudio(args: FullAudioUploadArgs): Promise<string> {
  const baseTags = buildFullAudioTags(args);

  if (args.useTurbo) {
    try {
      return await uploadWithTurbo({
        file: args.audio,
        tags: baseTags,
        paymentToken: args.turboPaymentToken || 'arweave',
      });
    } catch (e: any) {
      const msg = String(e?.message || e || '');
      const isGatewayIssue =
        msg.includes('getPrice') ||
        msg.includes('Bad Gateway') ||
        msg.includes('502') ||
        msg.includes('Website is offline');
      if (!isGatewayIssue) throw e;
    }
  }

  const data = await args.audio.arrayBuffer();
  if (data.byteLength > 10 * 1024 * 1024) {
    throw new Error('File too large for direct wallet upload (max ~10MB without Turbo).');
  }
  return uploadDataTx(data, args.audio.type || 'audio/mpeg', baseTags);
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
  const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
  const tx = await arweave.createTransaction({ data: new Uint8Array(data) });
  tags.forEach(({ name, value }) => tx.addTag(name, value));
  tx.addTag('Content-Type', contentType);

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
    [
      { name: 'App-Name', value: 'StreamVault' },
      { name: 'Type', value: 'cover-art' },
      ...tags,
    ]
  );
  return `${GATEWAY}/${txId}`;
}

async function waitForConfirmation(txId: string, timeoutMs = 45_000): Promise<boolean> {
  const Arweave = (await import('arweave')).default;
  const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
  const ario = Arweave.init({ host: 'ar-io.net', port: 443, protocol: 'https' });
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const status = await arweave.transactions.getStatus(txId);
      if (status.status === 200) return true;
    } catch {
      // ignore and retry
    }
    try {
      const status = await ario.transactions.getStatus(txId);
      if (status.status === 200) return true;
    } catch {
      // ignore and retry
    }
    await new Promise((r) => setTimeout(r, 2_000));
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
  }
): Promise<PublishResult> {
  try {
    console.info('[publish] Sample publish started', { title: args.title, artist: args.artist });
    const data = await args.sample.arrayBuffer();
    const txId = await uploadDataTx(
      data,
      args.sample.type || 'audio/mpeg',
      [
        { name: 'App-Name', value: 'StreamVault' },
        { name: 'Protocol', value: 'StreamVault' },
        { name: 'App-Version', value: '1.0.0' },
        { name: 'Type', value: 'audio-sample' },
        { name: 'Content-Type', value: args.sample.type || 'audio/mpeg' },
        { name: 'Title', value: args.title },
        { name: 'Artist', value: args.artist },
        { name: 'Duration-Seconds', value: String(args.durationSeconds) },
      ]
    );
    const confirmed = await waitForConfirmation(txId).catch(() => false);
    const permawebUrl = `${GATEWAY}/${txId}`;
    console.info('[publish] Sample publish complete', { txId, permawebUrl });
    return { success: true, txId, permawebUrl, arioUrl: `${AR_IO_GATEWAY}/${txId}`, confirmed };
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
  },
  creatorAddress: string,
  ctx: { libs: PermawebLibs | null }
): Promise<PublishResult> {
  const libs = ctx.libs;
  if (!libs?.createAtomicAsset) return { success: false, error: 'Atomic asset creation not available.' };

  try {
    console.info('[publish] Full asset publish started', { title: args.title, artist: args.artist });
    const udl = args.udl;
    const splits = args.splits;
    let artworkUrlToUse = args.artworkUrl;
    if (args.artworkFile) {
      console.info('[publish] Uploading cover image to Arweave');
      artworkUrlToUse = await uploadImageTx(args.artworkFile, [
        { name: 'Title', value: args.title },
        { name: 'Artist', value: args.artist },
      ]);
    }
    const txId = await uploadFullAudio({
      audio: args.audio,
      title: args.title,
      artist: args.artist,
      creatorAddress,
      useTurbo: args.useTurbo,
      turboPaymentToken: args.turboPaymentToken,
      udl,
      splits,
    });
    const confirmed = await waitForConfirmation(txId).catch(() => false);
    const permawebUrl = `${GATEWAY}/${txId}`;

    const metadata: Record<string, unknown> = {
      audioTxId: txId,
      artist: args.artist,
      artwork: artworkUrlToUse || undefined,
      royaltiesBps: args.royaltiesBps ?? undefined,
    };
    if (udl) metadata.udl = udl;
    if (splits && splits.length > 0) metadata.splits = splits;

    const assetTags: { name: string; value: string }[] = [
      { name: 'App-Name', value: 'StreamVault' },
      { name: 'Protocol', value: 'StreamVault' },
      { name: 'App-Version', value: '1.0.0' },
      { name: 'Type', value: 'music-atomic-asset' },
      { name: 'Track-AudioTx', value: txId },
      { name: 'Artist', value: args.artist },
      { name: 'Creator', value: creatorAddress },
    ];

    if (udl) {
      assetTags.push(
        { name: 'License', value: udl.licenseId },
        ...(udl.uri ? [{ name: 'License-URI', value: udl.uri }] : []),
        { name: 'License-Use', value: udl.usage.join(',') },
        { name: 'License-AI-Use', value: udl.aiUse },
        { name: 'License-Fee', value: udl.fee },
        { name: 'License-Fee-Unit', value: udl.interval },
        { name: 'License-Currency', value: udl.currency },
      );
    }

    if (splits && splits.length > 0) {
      assetTags.push({ name: 'Royalties-Splits', value: JSON.stringify(splits) });
    }

    const assetId = await libs.createAtomicAsset({
      name: args.title,
      description: args.description || `Permanent release by ${args.artist}`,
      topics: ['Music', 'StreamVault', 'Atomic-Asset'],
      creator: creatorAddress,
      data: permawebUrl,
      contentType: 'text/plain',
      assetType: 'audio',
      metadata,
      tags: assetTags,
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
          Title: args.title,
          Artist: args.artist,
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
      arioUrl: `${AR_IO_GATEWAY}/${txId}`,
      confirmed,
    };
  } catch (e: any) {
    console.error('[publish] Full asset publish failed', e);
    return { success: false, error: e?.message || 'Full asset publish failed' };
  }
}

export async function publishFullDirectToArweave(
  args: {
    audio: Blob;
    title: string;
    artist: string;
    description?: string;
    artworkUrl?: string;
    artworkFile?: Blob;
    udl?: UdlConfig;
    splits?: RoyaltySplit[];
    useTurbo?: boolean;
    turboPaymentToken?: TurboPaymentToken;
  },
  creatorAddress: string
): Promise<PublishResult> {
  try {
    console.info('[publish] Direct full upload started', { title: args.title, artist: args.artist });
    let artworkUrlToUse = args.artworkUrl;
    if (args.artworkFile) {
      artworkUrlToUse = await uploadImageTx(args.artworkFile, [
        { name: 'Title', value: args.title },
        { name: 'Artist', value: args.artist },
      ]);
    }

    const txId = await uploadFullAudio({
      audio: args.audio,
      title: args.title,
      artist: args.artist,
      creatorAddress,
      useTurbo: args.useTurbo,
      turboPaymentToken: args.turboPaymentToken,
      udl: args.udl,
      splits: args.splits,
    });

    const confirmed = await waitForConfirmation(txId).catch(() => false);
    const permawebUrl = `${GATEWAY}/${txId}`;

    console.info('[publish] Direct full upload complete', { txId, permawebUrl, artworkUrlToUse });

    return {
      success: true,
      txId,
      permawebUrl,
      arioUrl: `${AR_IO_GATEWAY}/${txId}`,
      confirmed,
    };
  } catch (e: any) {
    console.error('[publish] Direct full upload failed', e);
    return { success: false, error: e?.message || 'Direct full upload failed' };
  }
}
