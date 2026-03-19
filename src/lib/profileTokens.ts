import { resolveProfileMediaUrl } from './permaProfile';

export type ResolvedProfileToken = {
  id: string;
  name: string;
  ticker: string;
  imageUrl: string | null;
  denomination: number;
  rawBalance: string;
  displayBalance: string;
  kind: 'ao-token' | 'atomic-asset' | 'unknown';
  debug: {
    infoSource: 'readProcess' | 'atomicAsset' | 'none';
    assetType: string | null;
    hasTicker: boolean;
    hasDenomination: boolean;
  };
};

function pick(obj: any, keys: string[]): any {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function pickString(obj: any, keys: string[]): string | null {
  const value = pick(obj, keys);
  return typeof value === 'string' ? value : null;
}

function parseDenomination(info: any): number {
  const raw = pick(info, ['Denomination', 'denomination']);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function formatTokenBalance(rawBalance: string, denomination: number): string {
  try {
    const raw = BigInt(rawBalance || '0');
    if (denomination <= 0) return raw.toString();
    const base = BigInt(10) ** BigInt(denomination);
    const whole = raw / base;
    const fraction = raw % base;
    if (fraction === BigInt(0)) return whole.toString();
    const padded = fraction.toString().padStart(denomination, '0').replace(/0+$/, '');
    return `${whole.toString()}.${padded}`;
  } catch {
    const asNum = Number(rawBalance || 0);
    if (!Number.isFinite(asNum)) return '0';
    if (denomination <= 0) return String(asNum);
    return (asNum / Math.pow(10, denomination)).toString();
  }
}

function getTokenImage(info: any): string | null {
  const metadata = pick(info, ['Metadata', 'metadata']) || {};
  const imageRaw =
    pick(info, ['Logo', 'logo', 'Thumbnail', 'thumbnail', 'Image', 'image', 'Icon', 'icon']) ||
    pick(metadata, ['Logo', 'logo', 'Thumbnail', 'thumbnail', 'Image', 'image', 'Icon', 'icon']);
  return resolveProfileMediaUrl(imageRaw);
}

async function getTokenInfo(libs: any, tokenId: string): Promise<any> {
  let source: 'readProcess' | 'atomicAsset' | 'none' = 'none';
  let info: any = null;
  if (libs?.readProcess) {
    try {
      info = await libs.readProcess({
        processId: tokenId,
        action: 'Info',
      });
      if (info && Object.keys(info).length > 0) source = 'readProcess';
    } catch {
      // fallback below
    }
  }
  if (!info && libs?.getAtomicAsset) {
    try {
      info = await libs.getAtomicAsset(tokenId, { useGateway: true });
      if (info && Object.keys(info).length > 0) source = 'atomicAsset';
    } catch {
      // ignore
    }
  }
  return {
    data: info || {},
    source,
  };
}

function getAssetType(info: any): string | null {
  const metadata = pick(info, ['Metadata', 'metadata']) || {};
  const raw = pick(info, ['AssetType', 'assetType', 'Type', 'type']) || pick(metadata, ['AssetType', 'assetType', 'Type', 'type']);
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value ? value : null;
}

function getKind(info: any, ticker: string, denomination: number): 'ao-token' | 'atomic-asset' | 'unknown' {
  const metadata = pick(info, ['Metadata', 'metadata']) || {};
  const assetType = String(getAssetType(info) || '').toLowerCase();
  const metadataType = String(pick(metadata, ['Standard', 'standard']) || '').toLowerCase();

  const hasTokenSignals =
    Boolean(ticker) ||
    denomination > 0 ||
    typeof pick(info, ['Balances', 'balances', 'TotalSupply', 'totalSupply']) !== 'undefined';

  if (hasTokenSignals) return 'ao-token';
  if (
    assetType.includes('atomic') ||
    assetType.includes('collectible') ||
    assetType.includes('nft') ||
    metadataType.includes('ans-110')
  ) {
    return 'atomic-asset';
  }
  if (typeof pick(info, ['contentType', 'Content-Type', 'Topics', 'topics', 'Data']) !== 'undefined') {
    return 'atomic-asset';
  }
  return 'unknown';
}

export async function resolveProfileTokens(libs: any, assets: any[]): Promise<ResolvedProfileToken[]> {
  const list = Array.isArray(assets) ? assets : [];
  const tokens = await Promise.all(
    list.map(async (asset: any): Promise<ResolvedProfileToken | null> => {
      const id = String(asset?.id || '').trim();
      if (!id) return null;
      const rawBalance = String(
        pick(asset, ['quantity', 'balance', 'amount', 'Quantity', 'Balance', 'Amount']) || '0'
      );
      const infoResult = await getTokenInfo(libs, id);
      const info = infoResult.data;
      const denomination = parseDenomination(info);
      const name =
        pickString(info, ['Name', 'name']) ||
        pickString(pick(info, ['Metadata', 'metadata']) || {}, ['Name', 'name']) ||
        `Token ${id.slice(0, 6)}…`;
      const ticker =
        pickString(info, ['Ticker', 'ticker']) ||
        pickString(pick(info, ['Metadata', 'metadata']) || {}, ['Ticker', 'ticker']) ||
        '';
      const kind = getKind(info, ticker, denomination);
      const assetType = getAssetType(info);
      return {
        id,
        name,
        ticker,
        imageUrl: getTokenImage(info),
        denomination,
        rawBalance,
        displayBalance: formatTokenBalance(rawBalance, denomination),
        kind,
        debug: {
          infoSource: infoResult.source,
          assetType,
          hasTicker: Boolean(ticker),
          hasDenomination: denomination > 0,
        },
      };
    })
  );
  return tokens.filter(Boolean) as ResolvedProfileToken[];
}
