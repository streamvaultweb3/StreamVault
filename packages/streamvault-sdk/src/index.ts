export type StreamVaultSdkOptions = {
  permaweb?: any;
  ario?: {
    resolveArNSName(args: { name: string }): Promise<{ txId?: string; processId?: string } | null>;
  };
  gatewayUrl?: string;
  gqlUrl?: string;
  aoGatewayUrl?: string;
  hbReadNodes?: string[];
};

export type ProfileAssetRef = { id: string; quantity: string };

export type StreamVaultProfile = {
  id: string | null;
  walletAddress: string | null;
  displayName: string | null;
  handle: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  assets: ProfileAssetRef[];
  raw: any;
};

export type StreamVaultTrack = {
  id: string;
  audioTxId: string;
  title: string;
  artist: string;
  artistId: string;
  streamUrl: string;
  streamUrls: string[];
  artworkUrl?: string;
  assetId?: string;
  isPermanent: boolean;
  source: 'arweave';
  raw?: any;
};

export type StreamVaultAtomicAsset = {
  assetId: string;
  audioTxId: string | null;
  metadata: AtomicAssetDisplayMetadata | null;
};

export type StreamVaultProfileResolution = {
  input: string;
  method: 'wallet' | 'profile-id' | 'handle' | 'arns' | 'unknown';
  arnsName?: string;
  resolvedId?: string | null;
  profile: StreamVaultProfile | null;
};

export type UcmActiveOrder = {
  id: string;
  creator?: string;
  quantity?: string;
  price?: string;
  side?: string;
  raw?: any;
};

export type AssetUcmMarketStatus = {
  assetId: string;
  orderbookId: string | null;
  activityProcessId: string | null;
  orderbookSource: 'dedicated' | 'legacy' | 'none';
  orderbookReadSource: 'hb-info-post' | 'none';
  orderbookReachable: boolean;
  totalAskCount: number;
  asks: UcmActiveOrder[];
};

export type MarketplaceListing = {
  assetId: string;
  orderbookId: string | null;
  asks: UcmActiveOrder[];
};

type AtomicAssetDisplayMetadata = {
  title?: string;
  artist?: string;
  creator?: string;
  artworkUrl?: string;
};

const DEFAULT_GATEWAY = 'https://arweave.net';
const DEFAULT_L1_GQL = 'https://arweave-search.goldsky.com/graphql';
const DEFAULT_AO_GQL_GATEWAY = 'ao-search-gateway.goldsky.com';
const DEFAULT_HB_NODES = ['https://app-1.forward.computer', 'https://hb.portalinto.com'];

function normalizeLimit(limit: number | undefined, fallback: number): number {
  const n = Math.floor(Number(limit || fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, n), 100);
}

function isLikelyArweaveAddressRef(ref: string | undefined): boolean {
  return Boolean(ref && ref.length === 43 && /^[A-Za-z0-9_-]+$/.test(ref));
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function pickFirst(profile: any, keys: string[]): string | null {
  for (const key of keys) {
    const value = pickString(profile?.[key]);
    if (value) return value;
  }
  return null;
}

function normalizeTxId(raw: string): string {
  const s = String(raw || '').trim();
  const match = s.match(/[A-Za-z0-9_-]{43}/);
  return match?.[0] || s;
}

function dataUrl(txId: string, base = DEFAULT_GATEWAY): string {
  return `${base.replace(/\/+$/, '')}/${normalizeTxId(txId)}`;
}

function publicDataUrls(txId: string): string[] {
  const id = normalizeTxId(txId);
  return [
    `https://arweave.net/${id}`,
    `https://turbo-gateway.com/${id}`,
    `https://g8way.io/${id}`,
    `https://akrd.net/${id}`,
    `https://ardrive.net/${id}`,
  ];
}

function resolveMediaUrl(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (!value || value === 'None') return null;
    if (/^https?:\/\//i.test(value)) return value;
    if (isLikelyArweaveAddressRef(value)) return dataUrl(value);
  }
  if (typeof raw === 'object') {
    return resolveMediaUrl(raw.id || raw.Id || raw.txId || raw.TxId || raw.url || raw.Url);
  }
  return null;
}

function inferProfileWalletAddress(profile: any, fallback?: string | null): string | null {
  return pickFirst(profile, ['walletAddress', 'WalletAddress', 'owner', 'Owner']) || fallback || null;
}

function collectProfileAssetRefs(profile: any): ProfileAssetRef[] {
  const byId = new Map<string, string>();
  for (const raw of [profile?.assets, profile?.Assets]) {
    const rows = Array.isArray(raw) ? raw : [];
    for (const row of rows) {
      const id = pickString(row?.id) || pickString(row?.Id);
      if (!id) continue;
      const quantity = String(row?.quantity ?? row?.Quantity ?? row?.balance ?? row?.Balance ?? '1');
      byId.set(id, quantity);
    }
  }
  return Array.from(byId, ([id, quantity]) => ({ id, quantity }));
}

function toProfile(raw: any, fallbackWallet?: string | null): StreamVaultProfile {
  return {
    id: raw?.id ? String(raw.id) : null,
    walletAddress: inferProfileWalletAddress(raw, fallbackWallet),
    displayName: pickFirst(raw, ['displayName', 'DisplayName', 'name', 'Name']),
    handle: pickFirst(raw, ['handle', 'Handle', 'username', 'Username']),
    bio: pickFirst(raw, ['bio', 'Bio', 'description', 'Description']),
    avatarUrl: resolveMediaUrl(raw?.avatar ?? raw?.thumbnail ?? raw?.image ?? raw?.Avatar ?? raw?.Thumbnail ?? raw?.Image),
    bannerUrl: resolveMediaUrl(raw?.banner ?? raw?.cover ?? raw?.Banner ?? raw?.Cover),
    assets: collectProfileAssetRefs(raw),
    raw,
  };
}

async function gql(endpoint: string, query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL request failed: HTTP ${res.status}`);
  return res.json();
}

function tagValue(tags: Array<{ name?: string; value?: string }> | undefined, names: string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of tags || []) {
    if (wanted.has(String(tag?.name || '').toLowerCase())) {
      const value = pickString(tag?.value);
      if (value) return value;
    }
  }
  return null;
}

function audioNodeToTrack(node: any, assetId?: string | null): StreamVaultTrack {
  const tags = node?.tags || [];
  const title = tagValue(tags, ['Title', 'Bootloader-Name', 'Name']) || 'Untitled';
  const artist = tagValue(tags, ['Artist', 'Bootloader-Artist', 'Creator']) || 'Unknown artist';
  const artworkTxId = tagValue(tags, ['Artwork-Tx-Id', 'Bootloader-ArtworkTxId', 'Cover-Art-Tx-Id']);
  const id = String(node.id);
  return {
    id,
    audioTxId: id,
    title,
    artist,
    artistId: node?.owner?.address || id,
    streamUrl: publicDataUrls(id)[0],
    streamUrls: publicDataUrls(id),
    artworkUrl: artworkTxId ? publicDataUrls(artworkTxId)[0] : undefined,
    assetId: assetId || tagValue(tags, ['Asset-Id', 'Atomic-Asset', 'Process-Id']) || undefined,
    isPermanent: true,
    source: 'arweave',
    raw: node,
  };
}

function assetMetadataToTrack(assetId: string, audioTxId: string, metadata: AtomicAssetDisplayMetadata | null, fallbackArtist: string): StreamVaultTrack {
  return {
    id: assetId,
    audioTxId,
    title: metadata?.title || 'Untitled',
    artist: metadata?.artist || metadata?.creator || fallbackArtist || 'Unknown artist',
    artistId: metadata?.creator || assetId,
    streamUrl: publicDataUrls(audioTxId)[0],
    streamUrls: publicDataUrls(audioTxId),
    artworkUrl: metadata?.artworkUrl,
    assetId,
    isPermanent: true,
    source: 'arweave',
    raw: metadata,
  };
}

function mergeTracks(primary: StreamVaultTrack[], secondary: StreamVaultTrack[]): StreamVaultTrack[] {
  const byKey = new Map<string, StreamVaultTrack>();
  for (const track of [...primary, ...secondary]) {
    const key = track.assetId || track.audioTxId || track.id;
    if (!byKey.has(key)) byKey.set(key, track);
  }
  return Array.from(byKey.values());
}

async function fetchJsonFromHb(processId: string, subpath: string, nodes: string[]): Promise<Record<string, unknown> | null> {
  for (const node of nodes) {
    try {
      const url = `${node.replace(/\/+$/, '')}/${processId}~process@1.0/${subpath.replace(/^\/+/, '')}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const json = await res.json();
      if (json && typeof json === 'object') return json;
    } catch {
      // try next node
    }
  }
  return null;
}

function pickAtomicArtwork(info: Record<string, unknown>): string | undefined {
  const metadata = (info.Metadata || info.metadata) as Record<string, unknown> | undefined;
  const artworkTxId = pickString(metadata?.artworkTxId) || pickString(metadata?.ArtworkTxId) || pickString(info['Artwork-Tx-Id']);
  if (artworkTxId) return resolveMediaUrl(artworkTxId) || undefined;
  return (
    resolveMediaUrl(metadata?.artwork) ||
    resolveMediaUrl(metadata?.Artwork) ||
    resolveMediaUrl(metadata?.image) ||
    resolveMediaUrl(metadata?.Image) ||
    resolveMediaUrl(metadata?.thumbnail) ||
    resolveMediaUrl(metadata?.Thumbnail) ||
    undefined
  );
}

function atomicMetadataFromState(json: Record<string, unknown> | null): AtomicAssetDisplayMetadata | null {
  if (!json) return null;
  const metadata = (json.Metadata || json.metadata) as Record<string, unknown> | undefined;
  const title = pickString(metadata?.title) || pickString(metadata?.Title) || pickString(json.Name) || pickString(json['Bootloader-Name']) || undefined;
  const artist = pickString(metadata?.artist) || pickString(metadata?.Artist) || pickString(json['Bootloader-Artist']) || undefined;
  const creator = pickString(json.Creator) || pickString(metadata?.creator) || undefined;
  const artworkUrl = pickAtomicArtwork(json);
  if (!title && !artist && !artworkUrl) return null;
  return { title, artist, creator, artworkUrl };
}

async function findAudioTxIdForAtomicAsset(assetId: string, endpoint: string): Promise<string | null> {
  const id = String(assetId || '').trim();
  if (!id) return null;
  try {
    const json = await gql(
      endpoint,
      `query StreamVaultAudioForAsset($id: ID!) {
        transaction(id: $id) { id tags { name value } }
      }`,
      { id }
    );
    const tags = json?.data?.transaction?.tags ?? [];
    const linked = tagValue(tags, ['Track-AudioTx', 'Bootloader-AudioTxId', 'Data-Source']);
    if (linked && linked !== id) return linked;
  } catch {
    // ignore
  }
  return null;
}

export function createStreamVaultClient(options: StreamVaultSdkOptions = {}) {
  const permaweb = options.permaweb || null;
  const ario = options.ario || undefined;
  const l1Gql = options.gqlUrl || DEFAULT_L1_GQL;
  const aoGateway = options.aoGatewayUrl || DEFAULT_AO_GQL_GATEWAY;
  const hbNodes = options.hbReadNodes || DEFAULT_HB_NODES;

  return {
    async getProfileById(profileId: string): Promise<StreamVaultProfile | null> {
      const id = String(profileId || '').trim();
      if (!permaweb || !id) return null;
      const profile = await permaweb.getProfileById(id).catch(() => null);
      return profile?.id ? toProfile(profile) : null;
    },

    async getProfileByWallet(walletAddress: string): Promise<StreamVaultProfile | null> {
      const wallet = String(walletAddress || '').trim();
      if (!permaweb || !wallet) return null;
      if (permaweb.getProfileByWalletAddress) {
        const direct = await permaweb.getProfileByWalletAddress(wallet).catch(() => null);
        if (direct?.id) return toProfile(direct, wallet);
      }
      if (!permaweb.getGQLData) return null;
      const result = await permaweb.getGQLData({
        tags: [
          { name: 'Data-Protocol', values: ['ao'] },
          { name: 'Zone-Type', values: ['User'] },
        ],
        owners: [wallet],
        gateway: aoGateway,
      }).catch(() => null);
      const rows = result?.data || [];
      rows.sort((a: any, b: any) => (b?.node?.block?.timestamp || 0) - (a?.node?.block?.timestamp || 0));
      for (const row of rows) {
        const profile = await this.getProfileById(row?.node?.id);
        if (profile?.id) return toProfile(profile.raw, wallet);
      }
      return null;
    },

    async getProfileByHandle(_handle: string): Promise<StreamVaultProfile | null> {
      return null;
    },

    async resolveArNSProfile(name: string): Promise<StreamVaultProfile | null> {
      const arnsName = String(name || '').trim().replace(/\.ar\.io$/i, '').replace(/\.ar$/i, '');
      if (!permaweb || !arnsName || !ario?.resolveArNSName) return null;
      const record = await ario.resolveArNSName({ name: arnsName }).catch(() => null);
      const resolvedId = String(record?.txId || record?.processId || '').trim();
      return isLikelyArweaveAddressRef(resolvedId) ? this.getProfileById(resolvedId) : null;
    },

    async resolveProfile(ref: string): Promise<StreamVaultProfileResolution> {
      const input = String(ref || '').trim();
      if (!input) return { input, method: 'unknown', profile: null };
      if (/\.ar(\.io)?$/i.test(input)) {
        const profile = await this.resolveArNSProfile(input);
        return { input, method: 'arns', arnsName: input, resolvedId: profile?.id || null, profile };
      }
      if (isLikelyArweaveAddressRef(input)) {
        const byId = await this.getProfileById(input);
        if (byId?.id) return { input, method: 'profile-id', resolvedId: byId.id, profile: byId };
        const byWallet = await this.getProfileByWallet(input);
        return { input, method: 'wallet', resolvedId: byWallet?.id || null, profile: byWallet };
      }
      const byHandle = await this.getProfileByHandle(input);
      return { input, method: 'handle', resolvedId: byHandle?.id || null, profile: byHandle };
    },

    async getTracksByWallet(walletAddress: string, args?: { limit?: number }): Promise<StreamVaultTrack[]> {
      const wallet = String(walletAddress || '').trim();
      if (!wallet) return [];
      const limit = normalizeLimit(args?.limit, 50);
      const json = await gql(
        l1Gql,
        `query StreamVaultAudioByOwner($tags: [TagFilter!]!, $owners: [String!], $first: Int!) {
          transactions(tags: $tags, owners: $owners, first: $first, sort: HEIGHT_DESC) {
            edges { node { id tags { name value } block { timestamp } owner { address } } }
          }
        }`,
        {
          tags: [
            { name: 'App-Name', values: ['StreamVault'] },
            { name: 'Type', values: ['music'] },
          ],
          owners: [wallet],
          first: limit,
        }
      ).catch(() => null);
      return (json?.data?.transactions?.edges || []).map((edge: any) => audioNodeToTrack(edge.node));
    },

    async getTracksByProfile(profile: StreamVaultProfile, args?: { limit?: number }): Promise<StreamVaultTrack[]> {
      const limit = normalizeLimit(args?.limit, 50);
      const fallbackArtist = profile.displayName || profile.handle || profile.walletAddress || '';
      const [walletTracks, assetTracks] = await Promise.all([
        profile.walletAddress ? this.getTracksByWallet(profile.walletAddress, { limit }) : Promise.resolve([]),
        Promise.all(
          profile.assets.slice(0, limit).map(async (asset) => {
            const assetId = String(asset.id || '').trim();
            const [audioTxId, state] = await Promise.all([
              findAudioTxIdForAtomicAsset(assetId, l1Gql),
              fetchJsonFromHb(assetId, 'compute/asset', hbNodes),
            ]);
            if (!audioTxId) return null;
            return assetMetadataToTrack(assetId, audioTxId, atomicMetadataFromState(state), fallbackArtist);
          })
        ),
      ]);
      return mergeTracks(walletTracks, assetTracks.filter(Boolean) as StreamVaultTrack[]).slice(0, limit);
    },

    async getTrendingTracks(args?: { limit?: number }): Promise<StreamVaultTrack[]> {
      const limit = normalizeLimit(args?.limit, 24);
      const json = await gql(
        l1Gql,
        `query StreamVaultAudio($tags: [TagFilter!]!, $first: Int!) {
          transactions(tags: $tags, first: $first, sort: HEIGHT_DESC) {
            edges { node { id tags { name value } block { timestamp } owner { address } } }
          }
        }`,
        {
          tags: [
            { name: 'App-Name', values: ['StreamVault'] },
            { name: 'Type', values: ['music'] },
          ],
          first: limit,
        }
      ).catch(() => null);
      return (json?.data?.transactions?.edges || []).map((edge: any) => audioNodeToTrack(edge.node));
    },

    async getAtomicAsset(assetId: string): Promise<StreamVaultAtomicAsset> {
      const id = String(assetId || '').trim();
      const [audioTxId, state] = await Promise.all([
        findAudioTxIdForAtomicAsset(id, l1Gql),
        fetchJsonFromHb(id, 'compute/asset', hbNodes),
      ]);
      return { assetId: id, audioTxId, metadata: atomicMetadataFromState(state) };
    },

    async getAssetUcmAsks(assetId: string): Promise<UcmActiveOrder[]> {
      const status = await this.getAssetUcmMarketStatus(assetId);
      return status.asks;
    },

    async getAssetUcmMarketStatus(assetId: string): Promise<AssetUcmMarketStatus> {
      return {
        assetId,
        orderbookId: null,
        activityProcessId: null,
        orderbookSource: 'none',
        orderbookReadSource: 'none',
        orderbookReachable: false,
        totalAskCount: 0,
        asks: [],
      };
    },

    async getMarketplaceListings(_args?: { limit?: number }): Promise<MarketplaceListing[]> {
      return [];
    },

    getStreamUrls(audioTxId: string): string[] {
      return publicDataUrls(audioTxId);
    },

    getPreferredStreamUrl(audioTxId: string): string {
      return publicDataUrls(audioTxId)[0];
    },
  };
}

export type StreamVaultClient = ReturnType<typeof createStreamVaultClient>;
