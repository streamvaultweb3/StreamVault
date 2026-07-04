import {
  arweaveL1GraphqlEndpoint,
  arweaveTxDataUrl,
  arweaveTxMetaUrl,
  arweaveTxStatusUrls,
  lunarTxExplorerUrl,
  normalizeArweaveTxId,
  turboTxDataUrl,
} from './arweaveDataGateway';
import { arweaveArtistPath, looksLikeWalletAddress } from './arweaveArtist';
import { findAudioTxIdForAtomicAsset } from './arweaveDiscovery';
import type { UploadedTrackRecord } from './uploadedTracks';
import { udlConfigToTags } from './udl';

export type ArweaveTag = { name: string; value: string };

export type TxFieldRow = { label: string; value: string; href?: string; mono?: boolean };

export type ParsedTrackTags = {
  identity: TxFieldRow[];
  media: TxFieldRow[];
  license: TxFieldRow[];
  royalties: TxFieldRow[];
  audius: TxFieldRow[];
  app: TxFieldRow[];
  atomic: TxFieldRow[];
  other: ArweaveTag[];
};

export type ArweaveTxExplorerData = {
  /** Route / URL transaction id (may be AO process spawn). */
  txId: string;
  /** Canonical L1 audio data tx when `txId` is a process or tags were supplemented. */
  audioTxId?: string;
  /** AO atomic asset process id when known (same as `txId` on process routes). */
  processId?: string;
  metaUrl: string;
  transaction: {
    id: string;
    owner?: string;
    target?: string;
    quantityAr?: string;
    rewardAr?: string;
    dataSize?: number;
    format?: number;
    lastTx?: string;
    tags: ArweaveTag[];
  } | null;
  status: {
    httpStatus?: number;
    confirmed?: boolean;
    blockHeight?: number;
    confirmations?: number;
    blockInclusionHeight?: number;
  } | null;
  blockTimestamp?: number;
  graphqlFallback: boolean;
  warnings: string[];
};

const LICENSE_PREFIX = 'License';
const IDENTITY_KEYS = new Set([
  'Title',
  'Artist',
  'Creator',
  'Description',
  'Artist-Address',
  'Duration-Seconds',
  'Genre',
]);
const MEDIA_KEYS = new Set([
  'Type',
  'Content-Type',
  'Artwork-Tx-Id',
  'Cover-Art-Tx-Id',
  'Thumbnail-Tx-Id',
  'Track-AudioTx',
]);
const APP_KEYS = new Set(['App-Name', 'App-Version', 'Protocol-Name', 'Protocol-Version']);
const AUDIUS_KEYS = new Set(['Audius-Track-Id', 'Audius-User-Id']);
const ATOMIC_KEYS = new Set(['Track-Id', 'Data-Protocol', 'Asset-Type', 'Variant']);

/** Union tag lists; later sources override earlier values for the same name. */
export function mergeArweaveTags(
  ...sources: (ArweaveTag[] | null | undefined)[]
): ArweaveTag[] {
  const byName = new Map<string, string>();
  for (const source of sources) {
    if (!source?.length) continue;
    for (const { name, value } of source) {
      const n = String(name || '').trim();
      const v = String(value ?? '').trim();
      if (n && v) byName.set(n, v);
    }
  }
  return [...byName.entries()].map(([name, value]) => ({ name, value }));
}

/** Reconstruct Arweave tags from a local upload ledger entry (browser publish cache). */
export function uploadRecordToArweaveTags(record: UploadedTrackRecord): ArweaveTag[] {
  const tags: ArweaveTag[] = [{ name: 'App-Name', value: 'StreamVault' }];
  if (record.title) tags.push({ name: 'Title', value: record.title });
  if (record.artist) tags.push({ name: 'Artist', value: record.artist });
  if (record.walletAddress) tags.push({ name: 'Creator', value: record.walletAddress });
  if (record.description) tags.push({ name: 'Description', value: record.description });
  if (record.contentType) tags.push({ name: 'Content-Type', value: record.contentType });
  if (record.artworkTxId) tags.push({ name: 'Artwork-Tx-Id', value: record.artworkTxId });
  if (record.audiusTrackId) tags.push({ name: 'Audius-Track-Id', value: record.audiusTrackId });
  if (record.assetId) tags.push({ name: 'Track-Id', value: record.assetId });
  if (record.udl) {
    tags.push(
      ...udlConfigToTags({
        licenseId: record.udl.licenseId,
        uri: record.udl.uri,
        usage: record.udl.usage,
        aiUse: record.udl.aiUse,
        fee: record.udl.fee,
        currency: record.udl.currency,
        interval: record.udl.interval,
        attribution: record.udl.attribution,
      })
    );
  }
  if (record.splits?.length) {
    tags.push({ name: 'Royalties-Splits', value: JSON.stringify(record.splits) });
  }
  return tags;
}

export function trackDetailPath(txId: string): string {
  return `/track/${normalizeArweaveTxId(txId)}`;
}

function winstonToAr(winston: string | number | undefined): string | undefined {
  if (winston === undefined || winston === null || winston === '') return undefined;
  const n = typeof winston === 'string' ? Number(winston) : winston;
  if (!Number.isFinite(n)) return String(winston);
  const ar = n / 1e12;
  if (ar >= 0.0001) return `${ar.toFixed(6)} AR`;
  return `${ar.toExponential(2)} AR`;
}

function getTag(tags: ArweaveTag[], name: string): string | undefined {
  return tags.find((t) => t.name === name)?.value;
}

const AUDIO_TX_TAG_NAMES = ['Track-AudioTx', 'Bootloader-AudioTxId', 'Data-Source'] as const;

/** Linked L1 audio upload id from AO spawn / atomic asset tags. */
export function audioTxIdFromTags(tags: ArweaveTag[]): string | undefined {
  for (const name of AUDIO_TX_TAG_NAMES) {
    const value = String(getTag(tags, name) || '').trim();
    if (value) return value;
  }
  return undefined;
}

/** True when tags describe an AO atomic-asset process spawn (not the L1 audio data tx). */
export function isAoAtomicProcessTags(tags: ArweaveTag[]): boolean {
  if (getTag(tags, 'Data-Protocol') !== 'ao') return false;
  if (getTag(tags, 'Type') === 'Process') return true;
  return /atomic/i.test(getTag(tags, 'Asset-Type') || '');
}

function hasTrackMetadataTags(tags: ArweaveTag[]): boolean {
  if (getTag(tags, 'Title') || getTag(tags, 'Artist')) return true;
  return tags.some((t) => t.name.startsWith(LICENSE_PREFIX));
}

export function isAudioContentType(contentType?: string): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith('audio/') || ct.includes('mpeg') || ct.includes('mp3');
}

export function trackStreamUrl(txId: string, tags: ArweaveTag[], preferTurbo = true): string {
  const id = normalizeArweaveTxId(txId);
  if (preferTurbo && getTag(tags, 'App-Name') === 'StreamVault') {
    return turboTxDataUrl(id);
  }
  return arweaveTxDataUrl(id);
}

export function artworkUrlFromTags(tags: ArweaveTag[]): string | undefined {
  const artworkId =
    getTag(tags, 'Artwork-Tx-Id') ||
    getTag(tags, 'Cover-Art-Tx-Id') ||
    getTag(tags, 'Thumbnail-Tx-Id');
  return artworkId ? arweaveTxDataUrl(artworkId) : undefined;
}

function formatRoyaltiesValue(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((row) => {
          if (!row || typeof row !== 'object') return String(row);
          const r = row as Record<string, unknown>;
          const addr = String(r.address || '').slice(0, 8);
          const bps = r.shareBps ?? r.share_bps;
          const chain = r.chain || '';
          const token = r.token || '';
          return `${addr}… ${bps} bps (${chain}${token ? ` · ${token}` : ''})`;
        })
        .join('; ');
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

export function parseTrackTagSections(tags: ArweaveTag[]): ParsedTrackTags {
  const identity: TxFieldRow[] = [];
  const media: TxFieldRow[] = [];
  const license: TxFieldRow[] = [];
  const royalties: TxFieldRow[] = [];
  const audius: TxFieldRow[] = [];
  const app: TxFieldRow[] = [];
  const atomic: TxFieldRow[] = [];
  const other: ArweaveTag[] = [];
  const consumed = new Set<string>();

  const push = (list: TxFieldRow[], label: string, value: string, extra?: Partial<TxFieldRow>) => {
    if (!value) return;
    list.push({ label, value, ...extra });
    consumed.add(label);
  };

  const title = getTag(tags, 'Title');
  const artist = getTag(tags, 'Artist');
  const creator = getTag(tags, 'Creator') || getTag(tags, 'Artist-Address');
  const description = getTag(tags, 'Description');
  const duration = getTag(tags, 'Duration-Seconds');

  if (title) push(identity, 'Title', title);
  if (artist) push(identity, 'Artist', artist);
  if (creator) {
    push(identity, 'Creator', creator, {
      mono: true,
      href: looksLikeWalletAddress(creator) ? arweaveArtistPath(creator) : undefined,
    });
  }
  if (description) push(identity, 'Description', description);
  if (duration) push(identity, 'Duration', `${duration}s`);
  const genre = getTag(tags, 'Genre');
  if (genre) push(identity, 'Genre', genre);

  const contentType = getTag(tags, 'Content-Type');
  const type = getTag(tags, 'Type');
  if (type) push(media, 'Type', type);
  if (contentType) push(media, 'Content-Type', contentType);

  const artworkId =
    getTag(tags, 'Artwork-Tx-Id') ||
    getTag(tags, 'Cover-Art-Tx-Id') ||
    getTag(tags, 'Thumbnail-Tx-Id');
  if (artworkId) {
    push(media, 'Artwork tx', artworkId, {
      mono: true,
      href: trackDetailPath(artworkId),
    });
  }

  const audioTx = getTag(tags, 'Track-AudioTx');
  if (audioTx) {
    push(media, 'Audio tx', audioTx, { mono: true, href: trackDetailPath(audioTx) });
  }

  for (const t of tags) {
    if (!t.name.startsWith(LICENSE_PREFIX)) continue;
    push(license, t.name, t.value, t.name === 'License-URI' ? { href: t.value } : undefined);
    consumed.add(t.name);
  }

  const splits = getTag(tags, 'Royalties-Splits');
  if (splits) {
    push(royalties, 'Royalties-Splits', formatRoyaltiesValue(splits));
    consumed.add('Royalties-Splits');
  }

  const audiusId = getTag(tags, 'Audius-Track-Id');
  if (audiusId) {
    push(audius, 'Audius track', audiusId, {
      href: `https://audius.co/tracks/${encodeURIComponent(audiusId)}`,
    });
    consumed.add('Audius-Track-Id');
  }
  const audiusUser = getTag(tags, 'Audius-User-Id');
  if (audiusUser) {
    push(audius, 'Audius user', audiusUser);
    consumed.add('Audius-User-Id');
  }

  for (const t of tags) {
    if (APP_KEYS.has(t.name)) {
      push(app, t.name, t.value);
      consumed.add(t.name);
    }
  }

  const trackId = getTag(tags, 'Track-Id');
  if (trackId) {
    push(atomic, 'Track-Id (asset process)', trackId, { mono: true });
    consumed.add('Track-Id');
  }
  const dataProtocol = getTag(tags, 'Data-Protocol');
  const assetType = getTag(tags, 'Asset-Type');
  const variant = getTag(tags, 'Variant');
  if (dataProtocol) {
    push(atomic, 'Data-Protocol', dataProtocol);
    consumed.add('Data-Protocol');
  }
  if (assetType) {
    push(atomic, 'Asset-Type', assetType);
    consumed.add('Asset-Type');
  }
  if (variant) {
    push(atomic, 'Variant', variant);
    consumed.add('Variant');
  }

  if (getTag(tags, 'License-Currency')) consumed.add('Currency');

  for (const t of tags) {
    if (
      consumed.has(t.name) ||
      IDENTITY_KEYS.has(t.name) ||
      MEDIA_KEYS.has(t.name) ||
      APP_KEYS.has(t.name) ||
      AUDIUS_KEYS.has(t.name) ||
      ATOMIC_KEYS.has(t.name) ||
      t.name.startsWith(LICENSE_PREFIX) ||
      t.name === 'Royalties-Splits'
    ) {
      continue;
    }
    other.push(t);
  }

  return { identity, media, license, royalties, audius, app, atomic, other };
}

async function fetchJson(url: string): Promise<{ ok: boolean; status: number; json?: unknown }> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return { ok: true, status: res.status, json };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function fetchTxMeta(txId: string): Promise<ArweaveTxExplorerData['transaction'] | null> {
  const url = arweaveTxMetaUrl(txId);
  const { ok, json } = await fetchJson(url);
  if (!ok || !json || typeof json !== 'object') return null;
  const row = json as Record<string, unknown>;
  const tagsRaw = Array.isArray(row.tags) ? row.tags : [];
  const tags: ArweaveTag[] = tagsRaw
    .map((t: any) => ({
      name: String(t?.name ?? ''),
      value: String(t?.value ?? ''),
    }))
    .filter((t) => t.name);

  return {
    id: String(row.id || txId),
    owner: row.owner ? String(row.owner) : undefined,
    target: row.target ? String(row.target) : undefined,
    quantityAr: winstonToAr(row.quantity as string),
    rewardAr: winstonToAr(row.reward as string),
    dataSize: row.data_size != null ? Number(row.data_size) : undefined,
    format: row.format != null ? Number(row.format) : undefined,
    lastTx: row.last_tx ? String(row.last_tx) : undefined,
    tags,
  };
}

async function fetchTxStatus(txId: string): Promise<ArweaveTxExplorerData['status'] | null> {
  for (const url of arweaveTxStatusUrls(txId)) {
    const { ok, status, json } = await fetchJson(url);
    if (!ok || !json || typeof json !== 'object') continue;
    const row = json as Record<string, unknown>;
    const confirmed = row.confirmed as Record<string, unknown> | undefined;
    return {
      httpStatus: status,
      confirmed: Boolean(confirmed),
      blockHeight: confirmed?.block_height != null ? Number(confirmed.block_height) : undefined,
      confirmations:
        confirmed?.number_of_confirmations != null
          ? Number(confirmed.number_of_confirmations)
          : undefined,
      blockInclusionHeight:
        row.block_inclusion_height != null ? Number(row.block_inclusion_height) : undefined,
    };
  }
  return null;
}

async function fetchTxGraphql(txId: string): Promise<{
  tags: ArweaveTag[];
  owner?: string;
  blockTimestamp?: number;
  quantityAr?: string;
  dataSize?: number;
} | null> {
  const query = `
    query StreamVaultTxDetail($id: ID!) {
      transaction(id: $id) {
        id
        tags { name value }
        owner { address }
        block { height timestamp }
        data { size type }
        quantity { ar }
      }
    }
  `;
  const endpoint = arweaveL1GraphqlEndpoint();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { id: txId } }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const node = json?.data?.transaction;
    if (!node?.id) return null;
    const tags: ArweaveTag[] = (node.tags || [])
      .map((t: any) => ({ name: String(t.name), value: String(t.value) }))
      .filter((t: ArweaveTag) => t.name);
    return {
      tags,
      owner: node.owner?.address,
      blockTimestamp: node.block?.timestamp,
      quantityAr: node.quantity?.ar != null ? `${node.quantity.ar} AR` : undefined,
      dataSize: node.data?.size != null ? Number(node.data.size) : undefined,
    };
  } catch {
    return null;
  }
}

type TxBundle = {
  txId: string;
  transaction: ArweaveTxExplorerData['transaction'];
  status: ArweaveTxExplorerData['status'];
  gql: Awaited<ReturnType<typeof fetchTxGraphql>>;
  tags: ArweaveTag[];
  graphqlUsed: boolean;
};

async function loadTxBundle(txId: string): Promise<TxBundle> {
  const [transaction, status, gql] = await Promise.all([
    fetchTxMeta(txId),
    fetchTxStatus(txId),
    fetchTxGraphql(txId),
  ]);

  const metaTags = transaction?.tags ?? [];
  const gqlTags = gql?.tags ?? [];
  const tags = mergeArweaveTags(metaTags, gqlTags);
  const graphqlUsed = gqlTags.length > 0 && gqlTags.length >= metaTags.length;

  let mergedTx = transaction;
  if (tags.length) {
    mergedTx = mergedTx
      ? {
          ...mergedTx,
          tags,
          owner: mergedTx.owner || gql?.owner,
          quantityAr: mergedTx.quantityAr || gql?.quantityAr,
          dataSize: mergedTx.dataSize ?? gql?.dataSize,
        }
      : {
          id: txId,
          owner: gql?.owner,
          quantityAr: gql?.quantityAr,
          dataSize: gql?.dataSize,
          tags,
        };
  }

  return { txId, transaction: mergedTx, status, gql, tags, graphqlUsed };
}

export async function fetchArweaveTxExplorer(rawTxId: string): Promise<ArweaveTxExplorerData> {
  const txId = normalizeArweaveTxId(rawTxId);
  const warnings: string[] = [];
  let graphqlFallback = false;

  const primary = await loadTxBundle(txId);
  let tags = primary.tags;
  let mergedTx = primary.transaction;
  let status = primary.status;
  let blockTimestamp = primary.gql?.blockTimestamp;
  if (primary.graphqlUsed) graphqlFallback = true;

  let isProcess = isAoAtomicProcessTags(tags);
  let processId = isProcess ? txId : undefined;
  let audioTxId = isProcess ? audioTxIdFromTags(tags) : txId;

  if (isProcess && !audioTxId) {
    audioTxId = (await findAudioTxIdForAtomicAsset(txId)) || undefined;
  }

  if (!isProcess && !hasTrackMetadataTags(tags) && !primary.transaction) {
    const maybeAudio = await findAudioTxIdForAtomicAsset(txId);
    if (maybeAudio && maybeAudio !== txId) {
      isProcess = true;
      processId = txId;
      audioTxId = maybeAudio;
    }
  }

  if (!isProcess) {
    const trackId = getTag(tags, 'Track-Id');
    if (trackId && trackId !== txId) processId = trackId;
  }

  const shouldLoadAudio = Boolean(
    isProcess ? audioTxId : audioTxId && audioTxId !== txId && !hasTrackMetadataTags(tags)
  );

  if (shouldLoadAudio && audioTxId && (isProcess || audioTxId !== txId)) {
    const linkedAudioTxId = audioTxId;
    const audio = await loadTxBundle(linkedAudioTxId);
    if (audio.tags.length) {
      tags = mergeArweaveTags(audio.tags, tags);
      mergedTx = mergedTx
        ? {
            ...mergedTx,
            tags,
            owner: audio.transaction?.owner || mergedTx.owner,
            quantityAr: audio.transaction?.quantityAr || mergedTx.quantityAr,
            rewardAr: audio.transaction?.rewardAr || mergedTx.rewardAr,
            dataSize: audio.transaction?.dataSize ?? mergedTx.dataSize,
            format: audio.transaction?.format ?? mergedTx.format,
            lastTx: audio.transaction?.lastTx || mergedTx.lastTx,
          }
        : audio.transaction
          ? { ...audio.transaction, tags }
          : {
              id: linkedAudioTxId,
              owner: audio.gql?.owner,
              quantityAr: audio.gql?.quantityAr,
              dataSize: audio.gql?.dataSize,
              tags,
            };

      if (audio.status?.confirmed != null) status = audio.status;
      blockTimestamp = audio.gql?.blockTimestamp ?? blockTimestamp;
      audioTxId = linkedAudioTxId;

      if (audio.graphqlUsed) graphqlFallback = true;
      if (isProcess) {
        warnings.push(
          'Loaded L1 audio transaction metadata and merged with atomic asset process tags.'
        );
      } else if (tags.length > primary.tags.length) {
        warnings.push('Supplemented sparse tags from linked L1 audio transaction.');
      }
    }
  } else if (!isProcess) {
    audioTxId = txId;
  }

  if (primary.graphqlUsed && primary.tags.length === 0) {
    warnings.push(
      'L1 transaction metadata was not available from /tx/{id}; showing tags from GraphQL (common for Turbo bundled data items).'
    );
  } else if (primary.graphqlUsed && (primary.gql?.tags?.length ?? 0) > (primary.transaction?.tags?.length ?? 0)) {
    warnings.push(
      'GraphQL returned more tags than /tx/{id}; merged both sources (common for Turbo bundled data items).'
    );
  }

  if (!status?.confirmed && !graphqlFallback) {
    warnings.push(
      'Confirmation status may be unavailable until the transaction is mined or if this id is a bundled data item rather than an L1 tx.'
    );
  }

  if (!mergedTx) {
    warnings.push('Could not load transaction metadata for this id.');
  }

  const displayTxId = audioTxId && isProcess ? audioTxId : txId;

  return {
    txId,
    audioTxId: audioTxId || undefined,
    processId,
    metaUrl: arweaveTxMetaUrl(displayTxId),
    transaction: mergedTx,
    status,
    blockTimestamp,
    graphqlFallback,
    warnings,
  };
}

export function explorerTransactionRows(
  data: ArweaveTxExplorerData
): TxFieldRow[] {
  const tx = data.transaction;
  const displayTxId =
    data.audioTxId && data.processId && data.audioTxId !== data.txId
      ? data.audioTxId
      : data.txId;
  const rows: TxFieldRow[] = [
    { label: 'Transaction ID', value: displayTxId, mono: true },
  ];

  if (data.processId && data.processId !== displayTxId) {
    rows.push({
      label: 'Process ID',
      value: data.processId,
      mono: true,
      href: lunarTxExplorerUrl(data.processId),
    });
  }

  if (data.status?.httpStatus != null) {
    rows.push({ label: 'Status HTTP', value: String(data.status.httpStatus) });
  }
  if (data.status?.confirmed != null) {
    rows.push({
      label: 'Confirmed',
      value: data.status.confirmed ? 'Yes' : 'No',
    });
  }
  if (data.status?.blockHeight != null) {
    rows.push({ label: 'Block height', value: String(data.status.blockHeight) });
  }
  if (data.status?.confirmations != null) {
    rows.push({ label: 'Confirmations', value: String(data.status.confirmations) });
  }
  if (tx?.quantityAr) {
    rows.push({ label: 'Value', value: tx.quantityAr });
  }
  if (tx?.owner) {
    rows.push({
      label: 'From',
      value: tx.owner,
      mono: true,
      href: looksLikeWalletAddress(tx.owner) ? arweaveArtistPath(tx.owner) : `/profile/${tx.owner}`,
    });
  }
  if (tx?.rewardAr) {
    rows.push({ label: 'Fee', value: tx.rewardAr });
  }
  if (data.blockTimestamp) {
    rows.push({
      label: 'Timestamp',
      value: new Date(data.blockTimestamp * 1000).toLocaleString(),
    });
  }
  if (tx?.dataSize != null) {
    const kb = tx.dataSize / 1024;
    rows.push({
      label: 'Size',
      value: kb >= 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${kb.toFixed(1)} KB`,
    });
  }

  rows.push({
    label: 'Explorer',
    value: 'View on arweave.net',
    href: data.metaUrl,
  });
  rows.push({
    label: 'Data URL',
    value: 'Open raw data',
    href: arweaveTxDataUrl(displayTxId),
  });

  return rows;
}
