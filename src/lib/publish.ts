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
  ARWEAVE_DATA_GATEWAY_BASE,
  ARWEAVE_RELIABLE_DATA_GATEWAY_BASES,
  arweaveDataGatewayHost,
  arweaveTxDataUrl,
  arweaveTxStatusUrls,
  isArweaveSandboxGatewayUrl,
  normalizeArweaveTxId,
  turboTxDataUrl,
  TURBO_PUBLIC_DATA_GATEWAY_BASE,
} from './arweaveDataGateway';
import type { UdlConfig, RoyaltySplit } from './udl';
import { udlConfigToTags } from './udl';
import { registerTrackOnAO } from './aoMusicRegistry';
import { withResilientGlobalFetch } from './aoFetch';
import { resolveAoNode, resolveHbWriteNodeUrls } from './aoNode';
import { findAtomicAssetIdForAudioTx, fetchAtomicAssetMap } from './arweaveDiscovery';

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

/** Stable tag used to link an audio tx back to a separately uploaded cover artwork tx. */
export const STREAMVAULT_ARTWORK_TX_TAG = 'Artwork-Tx-Id';

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
    supply?: number;
    denomination?: number;
    transferable?: boolean;
    metadata?: Record<string, unknown>;
    tags?: { name: string; value: string }[];
  }) => Promise<string>;
}

/**
 * @permaweb/libs createAtomicAsset stringifies every metadata value via `.toString()`.
 * Undefined entries (e.g. `artwork: undefined`) throw; objects become `[object Object]`.
 * Only emit defined, string-serializable fields.
 */
function sanitizeAtomicAssetMetadata(
  metadata: Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.trim()) out[key] = value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
      continue;
    }
    try {
      out[key] = JSON.stringify(value);
    } catch {
      console.warn('[publish] Skipping non-serializable atomic metadata field', key);
    }
  }
  return out;
}

function extractAtomicAssetErrorDetail(error: unknown, depth = 0): string {
  if (!error || depth > 4) return '';
  if (typeof error === 'string') return error.trim();
  const e = error as Record<string, unknown>;
  const parts: string[] = [];
  const msg = String(e.message || '').trim();
  if (msg && msg !== 'Error spawning process' && msg !== 'Error creating asset') parts.push(msg);
  if (typeof e.status === 'number') parts.push(`HTTP ${e.status}`);
  if (typeof e.statusText === 'string' && e.statusText.trim()) parts.push(e.statusText.trim());
  if (typeof e.info === 'string' && e.info.trim()) parts.push(e.info.trim());
  if (typeof e.responseBody === 'string' && e.responseBody.trim()) {
    parts.push(e.responseBody.trim().slice(0, 240));
  }
  const cause = extractAtomicAssetErrorDetail(e.cause, depth + 1);
  if (cause) parts.push(cause);
  return parts.join(' — ');
}

function describeAtomicAssetError(error: unknown): string {
  const raw = String((error as { message?: string })?.message || error || '').trim();
  const detail = extractAtomicAssetErrorDetail(error);
  if (/Cannot read properties of undefined \(reading 'toString'\)/i.test(raw) || /undefined.*toString/i.test(raw)) {
    return 'Atomic asset mint failed: a metadata field was undefined. @permaweb/libs calls .toString() on every metadata value — omit empty optional fields (artwork, royalties, etc.).';
  }
  if (/HTTP request failed/i.test(raw) || raw === 'Error spawning process' || raw === 'Error creating asset') {
    const writeUrl = resolveHbWriteNodeUrls()[0] || resolveAoNode().url;
    const networkHint =
      /failed to fetch|network|ERR_CONNECTION|timed out|timeout|connection closed|connection refused/i.test(
        `${raw} ${detail}`
      )
        ? ' Network/VPN may be blocking or slowing HyperBEAM (Portal). Try toggling VPN or retry in a minute.'
        : '';
    const hint =
      detail ||
      `AO spawn POST to ${writeUrl}/push failed (check portal reachability, VITE_AO_WRITE_URL, scheduler, authority).`;
    return `Atomic asset mint failed: ${raw || 'spawn error'} — ${hint}${networkHint}`;
  }
  if (detail && detail !== raw) {
    return `Atomic asset mint failed: ${raw || 'spawn error'} (${detail})`;
  }
  if (!raw) return 'Atomic asset mint failed.';
  return `Atomic asset mint failed: ${raw}`;
}

type PublishAtomicContext = {
  libs: PermawebLibs | null;
  getWritableLibs?: (options?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    mode?: 'mainnet' | 'legacy';
  }) => Promise<PermawebLibs | null>;
};

type WritablePermawebLibs = PermawebLibs & {
  createAtomicAsset: NonNullable<PermawebLibs['createAtomicAsset']>;
};

function isTransientAtomicMintError(error: unknown): boolean {
  const raw = `${String((error as { message?: string })?.message || error || '')} ${extractAtomicAssetErrorDetail(error)}`;
  return /HTTP request failed|Error sending message|Error spawning process|Error creating asset|timed out|timeout|failed to fetch|network|ERR_CONNECTION|abort/i.test(
    raw
  );
}

/**
 * HyperBEAM spawn often finishes after the browser request times out.
 * Poll L1 GraphQL for Track-AudioTx → process id so the UI can confirm success.
 */
async function waitForIndexedAtomicAsset(args: {
  audioTxId: string;
  creatorAddress?: string | null;
  timeoutMs?: number;
  onTick?: (elapsedMs: number) => void;
}): Promise<string | null> {
  const audioTxId = String(args.audioTxId || '').trim();
  if (!audioTxId) return null;
  const timeoutMs = Math.max(30_000, args.timeoutMs ?? 180_000);
  const start = Date.now();
  let delayMs = 4_000;

  while (Date.now() - start < timeoutMs) {
    args.onTick?.(Date.now() - start);
    try {
      const fromTag = await findAtomicAssetIdForAudioTx(audioTxId);
      if (fromTag && fromTag !== audioTxId) return fromTag;
    } catch {
      // keep polling
    }
    try {
      const map = await fetchAtomicAssetMap({
        creator: args.creatorAddress || null,
        limit: 50,
      });
      const fromMap = map.get(audioTxId);
      if (fromMap && fromMap !== audioTxId) return fromMap;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(15_000, Math.floor(delayMs * 1.35));
  }
  return null;
}

async function resolveAtomicMintLibs(
  ctx: PublishAtomicContext
): Promise<WritablePermawebLibs | null> {
  const fallback = ctx.libs?.createAtomicAsset ? (ctx.libs as WritablePermawebLibs) : null;
  if (!ctx.getWritableLibs) return fallback;

  const writeUrl = resolveHbWriteNodeUrls()[0] || resolveAoNode().url;
  const node = resolveAoNode();
  try {
    const writable = await ctx.getWritableLibs({
      url: writeUrl,
      scheduler: node.scheduler,
      authority: node.authority,
      mode: 'mainnet',
    });
    if (writable?.createAtomicAsset) {
      console.info('[publish] Atomic mint using Portal write libs', {
        writeUrl,
        scheduler: node.scheduler,
        // Full id — earlier logs sliced to 12 chars and looked "too short".
        authority: node.authority,
      });
      return writable as WritablePermawebLibs;
    }
  } catch (e) {
    console.warn('[publish] getWritableLibs for atomic mint failed; falling back to default libs', e);
  }
  return fallback;
}

type TurboPaymentToken = 'arweave' | 'ethereum' | 'base-eth' | 'solana' | 'base-usdc' | 'base-ario' | 'polygon-usdc' | 'pol';

interface TurboUploadOptions {
  file: Blob | File;
  tags: { name: string; value: string }[];
  paymentToken: TurboPaymentToken;
  onProgress?: (progress: { processedBytes: number; totalBytes: number }) => void;
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

/** Phantom and other Solana wallets often expose the adapter on `window.solana` and/or `window.phantom.solana`. */
function getBrowserSolanaWalletAdapter(win: Window | null): any {
  if (!win) return null;
  const w = win as any;
  return w.solana ?? w.phantom?.solana ?? null;
}

async function uploadWithTurbo(args: TurboUploadOptions): Promise<string> {
  const win = typeof window !== 'undefined' ? window : null;
  const { TurboFactory, ArconnectSigner } = await import('@ardrive/turbo-sdk/web');

  let turbo;
  if (args.paymentToken === 'arweave') {
    const wallet = (win as any)?.arweaveWallet;
    if (!wallet) throw new Error('Wander wallet required for Turbo upload.');
    const signer = new ArconnectSigner(wallet);
    turbo = TurboFactory.authenticated({ signer });
  } else if (args.paymentToken === 'solana') {
    const walletAdapter = getBrowserSolanaWalletAdapter(win);
    if (!walletAdapter?.signTransaction) {
      throw new Error('Solana wallet required for Turbo upload. Connect Phantom (or another injected Solana wallet).');
    }
    turbo = TurboFactory.authenticated({ walletAdapter, token: 'solana' });
  } else {
    const provider = (win as any)?.ethereum;
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
        args.onProgress?.({ totalBytes, processedBytes });
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

/** Cover image via Turbo (same path as Turbo audio) so the id is discoverable on gateways together with bundled uploads. */
async function uploadArtworkWithTurbo(args: {
  artwork: Blob;
  title?: string;
  artist?: string;
  paymentToken: TurboPaymentToken;
  onProgress?: (progress: { processedBytes: number; totalBytes: number }) => void;
}): Promise<{ txId: string; permawebUrl: string; confirmed: boolean; gatewayReady: boolean; contentType: string }> {
  const contentType = args.artwork.type || 'image/jpeg';
  const tags: { name: string; value: string }[] = [
    { name: 'App-Name', value: 'StreamVault' },
    { name: 'Type', value: ANS110_TYPE_IMAGE },
    { name: 'Content-Type', value: contentType },
  ];
  if (args.title) tags.push({ name: 'Title', value: ans110Title(args.title) });
  if (args.artist) tags.push({ name: 'Artist', value: nfc(args.artist) });

  const txId = await uploadWithTurbo({
    file: args.artwork,
    tags: dedupeArweaveTags(tags),
    paymentToken: args.paymentToken,
    onProgress: args.onProgress,
  });
  const gatewayReady = await waitForGatewayImageReady(txId, contentType, 120_000, {
    preferTurbo: true,
  }).catch(() => false);
  return {
    txId,
    permawebUrl: arweaveTxDataUrl(txId),
    confirmed: true,
    gatewayReady,
    contentType,
  };
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
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 5_000));
        }
      } catch {
        // ignore and try next gateway
      }
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

/**
 * Ordered gateways for post-upload audio/image availability probes.
 * Prefer `arweave.net` + ardrive/g8way first — turbo-gateway.com / akrd.net often
 * ERR_CONNECTION_REFUSED under VPN even when Turbo upload itself succeeded.
 */
function gatewayReadyProbeUrls(txId: string, preferTurbo: boolean): string[] {
  const id = normalizeArweaveTxId(txId);
  const bases: string[] = [];
  const push = (base: string) => {
    if (!bases.includes(base)) bases.push(base);
  };
  push(ARWEAVE_DATA_GATEWAY_BASE);
  for (const base of ARWEAVE_RELIABLE_DATA_GATEWAY_BASES) {
    if (base.includes('turbo-gateway.com') || base.includes('akrd.net')) continue;
    push(base);
  }
  if (preferTurbo) push(TURBO_PUBLIC_DATA_GATEWAY_BASE);
  push('https://akrd.net');
  return bases.map((base) => `${base}/${id}`);
}

type GatewayProbeResult = 'ready' | 'not-ready' | 'rate-limited' | 'error';

async function probeGatewayMediaReady(
  url: string,
  kind: 'audio' | 'image',
  expectedContentType?: string
): Promise<GatewayProbeResult> {
  try {
    // Don't follow arweave.net → sandbox subdomain redirects (those 429 without VPN).
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-1' },
      cache: 'no-store',
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('Location') || res.headers.get('location') || '';
      if (!location || isArweaveSandboxGatewayUrl(location)) return 'rate-limited';
      try {
        const next = await fetch(new URL(location, url).toString(), {
          method: 'GET',
          headers: { Range: 'bytes=0-1' },
          cache: 'no-store',
          redirect: 'manual',
        });
        if (next.status === 429) return 'rate-limited';
        if (!(next.status === 200 || next.status === 206)) return 'not-ready';
        const contentType = (next.headers.get('content-type') || '').toLowerCase();
        if (kind === 'audio') {
          if (contentType.startsWith('audio/') || contentType.includes('mpeg') || contentType.includes('mp3')) {
            return 'ready';
          }
          return 'not-ready';
        }
        if (contentType.startsWith('image/')) return 'ready';
        return 'not-ready';
      } catch {
        return 'error';
      }
    }
    if (res.status === 429) return 'rate-limited';
    if (!(res.status === 200 || res.status === 206)) return 'not-ready';
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (expectedContentType && contentType && !contentType.includes(expectedContentType.toLowerCase().split(';')[0])) {
      return 'not-ready';
    }
    if (kind === 'audio') {
      if (contentType.startsWith('audio/') || contentType.includes('mpeg') || contentType.includes('mp3')) {
        return 'ready';
      }
      return 'not-ready';
    }
    if (contentType.startsWith('image/')) return 'ready';
    return 'not-ready';
  } catch {
    return 'error';
  }
}

async function isGatewayAudioReady(
  txId: string,
  expectedContentType?: string,
  opts?: { preferTurbo?: boolean }
): Promise<{ ready: boolean; rateLimited: boolean }> {
  let rateLimited = false;
  for (const url of gatewayReadyProbeUrls(txId, !!opts?.preferTurbo)) {
    const result = await probeGatewayMediaReady(url, 'audio', expectedContentType);
    if (result === 'ready') return { ready: true, rateLimited };
    if (result === 'rate-limited') rateLimited = true;
  }
  return { ready: false, rateLimited };
}

async function waitForGatewayAudioReady(
  txId: string,
  expectedContentType: string,
  timeoutMs = 120_000,
  opts?: { preferTurbo?: boolean }
): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    const { ready, rateLimited } = await isGatewayAudioReady(txId, expectedContentType, opts);
    if (ready) return true;
    attempt += 1;
    // Soften 429 hammering: exponential backoff up to 20s; otherwise polite 2–3s polls.
    const delayMs = rateLimited
      ? Math.min(20_000, 4_000 * 2 ** Math.min(attempt - 1, 2))
      : 2_500;
    if (rateLimited) {
      console.warn('[publish] Gateway audio probe rate-limited; backing off', { txId, delayMs, attempt });
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function isGatewayImageReady(
  txId: string,
  expectedContentType?: string,
  opts?: { preferTurbo?: boolean }
): Promise<{ ready: boolean; rateLimited: boolean }> {
  let rateLimited = false;
  for (const url of gatewayReadyProbeUrls(txId, !!opts?.preferTurbo)) {
    const result = await probeGatewayMediaReady(url, 'image', expectedContentType);
    if (result === 'ready') return { ready: true, rateLimited };
    if (result === 'rate-limited') rateLimited = true;
  }
  return { ready: false, rateLimited };
}

async function waitForGatewayImageReady(
  txId: string,
  expectedContentType?: string,
  timeoutMs = 120_000,
  opts?: { preferTurbo?: boolean }
): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    const { ready, rateLimited } = await isGatewayImageReady(txId, expectedContentType, opts);
    if (ready) return true;
    attempt += 1;
    const delayMs = rateLimited
      ? Math.min(20_000, 4_000 * 2 ** Math.min(attempt - 1, 2))
      : 2_500;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function inferContentTypeFromUrl(url: string): string | null {
  const lower = url.toLowerCase().split('?')[0].split('#')[0];
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return null;
}

async function fetchArtworkAsBlob(url: string): Promise<{ blob: Blob; contentType: string }> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`Artwork fetch failed (${res.status})`);
  const headerType = (res.headers.get('content-type') || '').split(';')[0].trim();
  const inferred = inferContentTypeFromUrl(url);
  const contentType = headerType || inferred || 'image/jpeg';
  const buf = await res.arrayBuffer();
  return { blob: new Blob([buf], { type: contentType }), contentType };
}

async function uploadArtworkTx(args: {
  artwork: Blob;
  title?: string;
  artist?: string;
}): Promise<{ txId: string; permawebUrl: string; confirmed: boolean; gatewayReady: boolean; contentType: string }> {
  const contentType = args.artwork.type || 'image/jpeg';
  const tags: { name: string; value: string }[] = [
    { name: 'App-Name', value: 'StreamVault' },
    { name: 'Type', value: ANS110_TYPE_IMAGE },
  ];
  if (args.title) tags.push({ name: 'Title', value: ans110Title(args.title) });
  if (args.artist) tags.push({ name: 'Artist', value: nfc(args.artist) });
  tags.push({ name: 'Content-Type', value: contentType });

  const txId = await uploadDataTx(await args.artwork.arrayBuffer(), contentType, dedupeArweaveTags(tags));
  const confirmed = await waitForConfirmation(txId, 120_000).catch(() => false);
  const gatewayReady = await waitForGatewayImageReady(txId, contentType, 120_000).catch(() => false);
  return { txId, permawebUrl: arweaveTxDataUrl(txId), confirmed, gatewayReady, contentType };
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
  },
  opts?: {
    onStage?: (stage: 'preparing' | 'uploading-audio' | 'confirming' | 'waiting-gateway' | 'done' | 'error') => void;
    onTxId?: (txId: string) => void;
  }
): Promise<PublishResult> {
  try {
    opts?.onStage?.('preparing');
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
    opts?.onStage?.('uploading-audio');
    const txId = await uploadDataTx(data, args.sample.type || 'audio/mpeg', dedupeArweaveTags(tags));
    opts?.onTxId?.(txId);
    opts?.onStage?.('confirming');
    const confirmed = await waitForConfirmation(txId).catch(() => false);
    opts?.onStage?.('waiting-gateway');
    const gatewayReady = await waitForGatewayAudioReady(txId, args.sample.type || 'audio/mpeg', 60_000, {
      preferTurbo: false,
    }).catch(() => false);
    const permawebUrl = arweaveTxDataUrl(txId);
    console.info('[publish] Sample publish complete', { txId, permawebUrl });
    opts?.onStage?.('done');
    return { success: true, txId, permawebUrl, arioUrl: turboTxDataUrl(txId), confirmed, gatewayReady };
  } catch (e: any) {
    console.error('[publish] Sample publish failed', e);
    opts?.onStage?.('error');
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
    /** If true (default), only upload the signed data tx with tags (no permaweb-libs atomic asset). Pass false to mint. */
    skipAtomicAsset?: boolean;
    audiusTrackId?: string;
    fromAudiusStream?: boolean;
  },
  creatorAddress: string,
  ctx: PublishAtomicContext,
  opts?: {
    onStage?: (stage:
      | 'preparing'
      | 'uploading-cover'
      | 'uploading-audio'
      | 'confirming'
      | 'waiting-gateway'
      | 'creating-atomic-asset'
      | 'confirming-atomic-asset'
      | 'registering-ao'
      | 'done'
      | 'error'
    ) => void;
    onProgress?: (progress: {
      kind: 'cover' | 'audio';
      processedBytes: number;
      totalBytes: number;
    }) => void;
    onTxId?: (txId: string) => void;
    onArtworkTxId?: (txId: string) => void;
  }
): Promise<PublishResult> {
  const libs = ctx.libs;
  // Default: regular data-tx upload. Atomic mint only when caller sets skipAtomicAsset: false
  // (PublishModal does that only when “Create atomic asset (experimental)” is checked).
  const skipAtomicAsset = args.skipAtomicAsset !== false;
  if (!skipAtomicAsset && !libs?.createAtomicAsset) {
    return { success: false, error: 'Atomic asset creation not available. Turn off “Create atomic asset (experimental)” to upload audio + UDL tags only.' };
  }

  try {
    opts?.onStage?.('preparing');
    const title = ans110Title(args.title);
    const artist = nfc(args.artist);
    console.info('[publish] Full asset publish started', { title, artist });
    const udl = args.udl;
    const splits = args.splits;
    let artworkUrlToUse = args.artworkUrl;
    let artworkTxId: string | undefined;

    const turboToken = args.turboPaymentToken || 'arweave';
    if (args.artworkFile) {
      opts?.onStage?.('uploading-cover');
      console.info('[publish] Uploading cover image', { turbo: !!args.useTurbo });
      const uploaded = args.useTurbo
        ? await uploadArtworkWithTurbo({
            artwork: args.artworkFile,
            title,
            artist,
            paymentToken: turboToken,
            onProgress: (p) => opts?.onProgress?.({ kind: 'cover', ...p }),
          })
        : await uploadArtworkTx({ artwork: args.artworkFile, title, artist });
      artworkTxId = uploaded.txId;
      opts?.onArtworkTxId?.(uploaded.txId);
      artworkUrlToUse = uploaded.permawebUrl;
      if (!uploaded.confirmed || !uploaded.gatewayReady) {
        console.info('[publish] Artwork uploaded but still propagating', uploaded);
      }
    } else if (typeof args.artworkUrl === 'string' && args.artworkUrl.trim()) {
      // Audius artwork URLs generally allow CORS, but if it fails we fall back to using the remote URL.
      try {
        opts?.onStage?.('uploading-cover');
        console.info('[publish] Uploading cover image (remote URL)', { turbo: !!args.useTurbo });
        const { blob } = await fetchArtworkAsBlob(args.artworkUrl);
        const uploaded = args.useTurbo
          ? await uploadArtworkWithTurbo({
              artwork: blob,
              title,
              artist,
              paymentToken: turboToken,
              onProgress: (p) => opts?.onProgress?.({ kind: 'cover', ...p }),
            })
          : await uploadArtworkTx({ artwork: blob, title, artist });
        artworkTxId = uploaded.txId;
        opts?.onArtworkTxId?.(uploaded.txId);
        artworkUrlToUse = uploaded.permawebUrl;
        if (!uploaded.confirmed || !uploaded.gatewayReady) {
          console.info('[publish] Artwork uploaded but still propagating', uploaded);
        }
      } catch (e) {
        console.warn('[publish] Could not fetch/upload artwork URL; keeping original artworkUrl', e);
      }
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
    if (artworkTxId) {
      baseTags.push({ name: STREAMVAULT_ARTWORK_TX_TAG, value: artworkTxId });
    }
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
        opts?.onStage?.('uploading-audio');
        txId = await uploadWithTurbo({
          file: args.audio,
          tags: dedupeArweaveTags(baseTags),
          paymentToken: args.turboPaymentToken || 'arweave',
          onProgress: (p) => opts?.onProgress?.({ kind: 'audio', ...p }),
        });
        opts?.onTxId?.(txId);
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
          opts?.onStage?.('uploading-audio');
          const data = await args.audio.arrayBuffer();
          txId = await uploadDataTx(
            data,
            args.audio.type || 'audio/mpeg',
            dedupeArweaveTags(baseTags)
          );
          opts?.onTxId?.(txId);
        } else {
          throw e;
        }
      }
    } else {
      opts?.onStage?.('uploading-audio');
      const data = await args.audio.arrayBuffer();
      if (data.byteLength > 10 * 1024 * 1024) return { success: false, error: 'File too large (max ~10MB).' };

      txId = await uploadDataTx(
        data,
        args.audio.type || 'audio/mpeg',
        dedupeArweaveTags(baseTags)
      );
      opts?.onTxId?.(txId);
    }
    let confirmed = false;
    if (usedTurboUpload) {
      // Turbo returns a data item id that is immediately usable as a gateway URL,
      // but `/tx/<id>/status` is not a reliable confirmation endpoint for that id.
      // Treat Turbo upload success as accepted and verify availability via data URL probing instead.
      confirmed = true;
      console.info('[publish] Turbo upload accepted; skipping raw tx status polling', { txId });
    } else {
      opts?.onStage?.('confirming');
      console.info('[publish] Waiting for L1 confirmation (GraphQL discovery is usually post-confirmation)', {
        txId,
        confirmTimeoutMs,
      });
      confirmed = await waitForConfirmation(txId, confirmTimeoutMs).catch(() => false);
    }
    const gatewayReadyTimeoutMs = usedTurboUpload
      ? // Turbo already accepted the item; briefly probe Turbo/CDN and don't block on arweave.net.
        Math.min(45_000, Math.max(12_000, Math.floor((args.audio.size / (1024 * 1024)) * 8_000) + 12_000))
      : Math.min(
          240_000,
          Math.max(90_000, Math.floor((args.audio.size / (1024 * 1024)) * 45_000) + 60_000)
        );
    console.info('[publish] Waiting for gateway audio availability', {
      txId,
      gatewayReadyTimeoutMs,
      preferTurbo: usedTurboUpload,
    });
    opts?.onStage?.('waiting-gateway');
    const gatewayReady = await waitForGatewayAudioReady(
      txId,
      args.audio.type || 'audio/mpeg',
      gatewayReadyTimeoutMs,
      { preferTurbo: usedTurboUpload }
    ).catch(() => false);
    if (!gatewayReady && usedTurboUpload) {
      console.info(
        '[publish] Gateway audio not confirmed yet after Turbo upload; continuing (Turbo accepted the data item)',
        { txId }
      );
    }
    const permawebUrl = arweaveTxDataUrl(txId);

    if (skipAtomicAsset) {
      try {
        opts?.onStage?.('registering-ao');
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
      opts?.onStage?.('done');
      return {
        success: true,
        txId,
        assetId: undefined,
        permawebUrl,
        arioUrl: turboTxDataUrl(txId),
        confirmed,
        gatewayReady,
        artworkTxId,
      };
    }

    const mintLibs = await resolveAtomicMintLibs(ctx);
    if (!mintLibs?.createAtomicAsset) {
      return { success: false, error: 'Atomic asset creation not available.' };
    }

    // Only include defined metadata — @permaweb/libs calls .toString() on every value.
    const metadata = sanitizeAtomicAssetMetadata({
      audioTxId: txId,
      artist,
      ...(artworkUrlToUse ? { artwork: artworkUrlToUse } : {}),
      ...(artworkTxId ? { artworkTxId } : {}),
      ...(typeof args.royaltiesBps === 'number' && Number.isFinite(args.royaltiesBps)
        ? { royaltiesBps: args.royaltiesBps }
        : {}),
      ...(udl ? { udl } : {}),
      ...(splits && splits.length > 0 ? { splits } : {}),
    });

    opts?.onStage?.('creating-atomic-asset');
    const assetTags: { name: string; value: string }[] = [
      { name: 'App-Name', value: 'StreamVault' },
      { name: 'Type', value: ANS110_TYPE_MUSIC },
      { name: 'Title', value: title },
      { name: 'Track-AudioTx', value: txId },
      { name: 'Artist', value: artist },
      { name: 'Creator', value: creatorAddress },
    ];
    if (artworkTxId) {
      assetTags.push({ name: STREAMVAULT_ARTWORK_TX_TAG, value: artworkTxId });
    }

    if (udl) {
      assetTags.push(...udlConfigToTags(udl));
    }

    if (splits && splits.length > 0) {
      assetTags.push({ name: 'Royalties-Splits', value: JSON.stringify(splits) });
    }

    if (!title || !creatorAddress) {
      return {
        success: false,
        error: 'Atomic asset mint requires a non-empty title and creator address.',
      };
    }

    let assetId: string | null = null;
    let mintError: unknown = null;
    try {
      // aoconnect spawn uses global fetch (ignores connect({ fetch })). Wrap globally for Portal→peer failover.
      assetId = await withResilientGlobalFetch(
        () =>
          mintLibs.createAtomicAsset({
            name: title,
            description: args.description || `Permanent release by ${artist}`,
            topics: ['Music', 'StreamVault', 'Atomic-Asset'],
            creator: creatorAddress,
            data: permawebUrl,
            contentType: 'text/plain',
            assetType: 'audio',
            supply: 1,
            denomination: 1,
            transferable: true,
            metadata,
            tags: dedupeArweaveTags(assetTags),
          }),
        {
          writeNodeUrls: resolveHbWriteNodeUrls(),
          // Fail Portal quickly (10s) then try Bazar — don't burn minutes on Portal hangs.
          pushAttemptTimeoutMs: 10_000,
          retries: 1,
          hostFailoverFirst: true,
        }
      );
    } catch (e) {
      mintError = e;
      console.warn('[publish] createAtomicAsset request failed; will poll GraphQL for delayed spawn', e);
    }

    // HyperBEAM often finishes spawn after the browser HTTP call times out — confirm via Track-AudioTx.
    if (!assetId) {
      opts?.onStage?.('confirming-atomic-asset');
      const recovered = await waitForIndexedAtomicAsset({
        audioTxId: txId,
        creatorAddress,
        timeoutMs: isTransientAtomicMintError(mintError) || !mintError ? 180_000 : 60_000,
        onTick: (elapsedMs) => {
          if (elapsedMs > 0 && elapsedMs % 20_000 < 5_000) {
            console.info('[publish] Waiting for atomic asset index…', {
              txId,
              elapsedSec: Math.round(elapsedMs / 1000),
            });
          }
        },
      });
      if (recovered) {
        console.info('[publish] Atomic mint recovered after delay', { txId, assetId: recovered });
        assetId = recovered;
        mintError = null;
      }
    }

    if (!assetId) {
      console.error('[publish] createAtomicAsset failed / not indexed yet', mintError, {
        metadataKeys: Object.keys(metadata),
        writeUrl: resolveHbWriteNodeUrls()[0],
        authority: resolveAoNode().authority,
        scheduler: resolveAoNode().scheduler,
      });
      // Soft success: audio is permanent; mint may still land — don't scare users with a hard fail.
      return {
        success: true,
        txId,
        assetId: undefined,
        mintPending: true,
        permawebUrl,
        arioUrl: turboTxDataUrl(txId),
        confirmed,
        gatewayReady,
        artworkTxId,
        error:
          'Audio uploaded successfully. Atomic mint is still confirming on HyperBEAM (this can take several minutes). ' +
          'Refresh this track or your profile before publishing the same song again.' +
          (mintError ? ` (${describeAtomicAssetError(mintError)})` : ''),
      };
    }

    console.info('[publish] Full asset publish complete', { txId, assetId, permawebUrl });

    // Best-effort AO registration for discovery and royalty engine usage.
    try {
      opts?.onStage?.('registering-ao');
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
    opts?.onStage?.('done');
    return {
      success: true,
      txId,
      assetId,
      permawebUrl,
      arioUrl: turboTxDataUrl(txId),
      confirmed,
      gatewayReady,
      artworkTxId,
    };
  } catch (e: any) {
    console.error('[publish] Full asset publish failed', e);
    opts?.onStage?.('error');
    return {
      success: false,
      error: describePublishError(e, {
        useTurbo: args.useTurbo,
        fromAudiusStream: args.fromAudiusStream,
      }),
    };
  }
}
