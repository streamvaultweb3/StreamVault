/**
 * StreamVault atomic asset drop configuration and claim helpers.
 */
import { connect, createDataItemSigner, result } from '@permaweb/aoconnect';
import { fetchHyperbeamAssetState } from './hbNode';
import { resolveAoNode } from './aoNode';
import dropAddonLua from './streamvaultDropAddon.lua?raw';

export type DropDistribution = 'hold' | 'claim-free' | 'claim-paid';

export type AtomicAssetEditionConfig = {
  /** Total token supply minted on the process (1 = 1/1). */
  supply: number;
  distribution: DropDistribution;
  /** Human-readable AR amount for paid drops (stored as winston on-chain). */
  claimPriceAr?: string;
  dropName?: string;
};

export type DropConfigState = {
  totalSupply: number;
  claimed: number;
  remaining: number;
  claimPriceWinston: string;
  dropMode: 'free' | 'paid';
  name?: string;
};

export type DropPublishMeta = {
  supply: number;
  distribution: DropDistribution;
  claimPriceAr?: string;
  claimPagePath?: string;
};

const WINSTON_PER_AR = 1_000_000_000_000n;

export function arToWinston(ar: string | number | undefined): string {
  const raw = String(ar ?? '0').trim();
  if (!raw || raw === '0') return '0';
  const [whole, frac = ''] = raw.split('.');
  const padded = (frac + '000000000000').slice(0, 12);
  try {
    return (BigInt(whole || '0') * WINSTON_PER_AR + BigInt(padded)).toString();
  } catch {
    return '0';
  }
}

export function winstonToAr(winston: string | undefined): string {
  if (!winston || winston === '0') return '0';
  try {
    const w = BigInt(winston);
    const whole = w / WINSTON_PER_AR;
    const frac = w % WINSTON_PER_AR;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(12, '0').replace(/0+$/, '');
    return `${whole}.${fracStr}`;
  } catch {
    return '0';
  }
}

export function claimPagePath(assetId: string): string {
  return `/claim/${encodeURIComponent(assetId.trim())}`;
}

export function claimPageUrl(assetId: string): string {
  if (typeof window === 'undefined') return claimPagePath(assetId);
  return `${window.location.origin}${window.location.pathname}#${claimPagePath(assetId)}`;
}

export function isClaimDrop(distribution: DropDistribution | undefined): boolean {
  return distribution === 'claim-free' || distribution === 'claim-paid';
}

export function dropModeFromDistribution(distribution: DropDistribution): 'free' | 'paid' {
  return distribution === 'claim-paid' ? 'paid' : 'free';
}

export function buildDropConfigInitLua(config: AtomicAssetEditionConfig, title: string): string {
  const supply = Math.max(1, Math.floor(config.supply || 1));
  const dropMode = dropModeFromDistribution(config.distribution);
  const claimPriceWinston =
    config.distribution === 'claim-paid' ? arToWinston(config.claimPriceAr) : '0';
  const safeName = (config.dropName || title || 'StreamVault Drop').replace(/'/g, "\\'");
  return `
DropConfig = {
  TotalSupply = ${supply},
  ClaimPriceWinston = '${claimPriceWinston}',
  DropMode = '${dropMode}',
  Name = '${safeName}',
}
Claims = {}
`;
}

export function buildDropEvalSource(config: AtomicAssetEditionConfig, title: string): string {
  return `${buildDropConfigInitLua(config, title)}\n${dropAddonLua}`;
}

function pickRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function parseDropConfigFromHb(json: Record<string, unknown>): DropConfigState | null {
  const dropRaw =
    pickRecord(json.DropConfig) ||
    pickRecord(json.dropConfig) ||
    pickRecord(json.CampaignConfig) ||
    pickRecord(json.campaignConfig);
  if (!dropRaw) return null;

  const totalSupply = Number(dropRaw.TotalSupply ?? dropRaw.totalSupply ?? 0);
  const claimsRaw = pickRecord(json.Claims) || pickRecord(json.claims) || {};
  let claimed = 0;
  for (const _key in claimsRaw) claimed += 1;

  const claimPriceWinston = String(dropRaw.ClaimPriceWinston ?? dropRaw.claimPriceWinston ?? '0');
  const dropModeRaw = String(dropRaw.DropMode ?? dropRaw.dropMode ?? 'free');
  const dropMode = dropModeRaw === 'paid' ? 'paid' : 'free';

  return {
    totalSupply: Number.isFinite(totalSupply) && totalSupply > 0 ? totalSupply : 1,
    claimed,
    remaining: Math.max(0, (Number.isFinite(totalSupply) ? totalSupply : 1) - claimed),
    claimPriceWinston,
    dropMode,
    name: typeof dropRaw.Name === 'string' ? dropRaw.Name : undefined,
  };
}

export async function fetchDropStateFromHyperbeam(assetId: string): Promise<{
  assetName?: string;
  creator?: string;
  metadata?: Record<string, unknown>;
  drop: DropConfigState | null;
}> {
  const hb = await fetchHyperbeamAssetState(assetId);
  if (!hb?.json) return { drop: null };
  const json = hb.json;
  return {
    assetName: typeof json.Name === 'string' ? json.Name : undefined,
    creator: typeof json.Creator === 'string' ? json.Creator : undefined,
    metadata: pickRecord(json.Metadata) || undefined,
    drop: parseDropConfigFromHb(json),
  };
}

function getInjectedWallet(): any | null {
  if (typeof window === 'undefined') return null;
  return (window as any).arweaveWallet || null;
}

export async function injectDropHandlers(args: {
  processId: string;
  config: AtomicAssetEditionConfig;
  title: string;
}): Promise<void> {
  const wallet = getInjectedWallet();
  if (!wallet) throw new Error('Connect Wander to install drop claim handlers.');

  const node = resolveAoNode();
  const signer = createDataItemSigner(wallet);
  const ao = connect({
    MODE: 'mainnet',
    URL: node.url,
    SCHEDULER: node.scheduler,
    signer,
  } as any);

  const evalSrc = buildDropEvalSource(args.config, args.title);
  const messageId = await ao.message({
    process: args.processId,
    signer,
    tags: [
      { name: 'Action', value: 'Eval' },
      { name: 'Message-Timestamp', value: Date.now().toString() },
    ],
    data: evalSrc,
  });

  await result({ message: messageId, process: args.processId }).catch(() => undefined);
  await ao.message({
    process: args.processId,
    signer,
    tags: [
      { name: 'Action', value: 'Sync-State' },
      { name: 'Message-Timestamp', value: Date.now().toString() },
    ],
  }).catch(() => undefined);
}

export async function sendDropClaim(args: {
  processId: string;
  recipient: string;
  walletAddress: string;
}): Promise<{ messageId: string }> {
  const wallet = getInjectedWallet();
  if (!wallet) throw new Error('Connect Wander to claim this drop.');

  const node = resolveAoNode();
  const signer = createDataItemSigner(wallet);
  const ao = connect({
    MODE: 'mainnet',
    URL: node.url,
    SCHEDULER: node.scheduler,
    signer,
  } as any);

  const messageId = await ao.message({
    process: args.processId,
    signer,
    tags: [
      { name: 'Action', value: 'Claim' },
      { name: 'Recipient', value: args.recipient },
      { name: 'Wallet-Address', value: args.walletAddress },
      { name: 'Message-Timestamp', value: Date.now().toString() },
    ],
    data: JSON.stringify({ recipient: args.recipient }),
  });

  return { messageId };
}

export async function dryRunDropStats(processId: string): Promise<DropConfigState | null> {
  const ao = connect({ MODE: 'legacy' } as any);
  const res: any = await ao.dryrun({
    process: processId,
    tags: [{ name: 'Action', value: 'Get-Drop-Stats' }],
  });
  const message = res.Messages?.[0];
  if (!message?.Data) return null;
  try {
    const parsed = JSON.parse(message.Data);
    const totalSupply = Number(parsed.TotalSupply ?? 0);
    const claimed = Number(parsed.Claimed ?? 0);
    const remaining = Number(parsed.Remaining ?? Math.max(0, totalSupply - claimed));
    const claimPriceWinston = String(parsed.ClaimPriceWinston ?? '0');
    const dropModeRaw = String(parsed.DropMode ?? 'free');
    return {
      totalSupply: totalSupply || 1,
      claimed,
      remaining,
      claimPriceWinston,
      dropMode: dropModeRaw === 'paid' ? 'paid' : 'free',
      name: typeof parsed.Name === 'string' ? parsed.Name : undefined,
    };
  } catch {
    return null;
  }
}

export function dropTagsFromConfig(config: AtomicAssetEditionConfig): { name: string; value: string }[] {
  const supply = Math.max(1, Math.floor(config.supply || 1));
  const tags: { name: string; value: string }[] = [
    { name: 'StreamVault-Edition-Supply', value: String(supply) },
    { name: 'StreamVault-Drop-Mode', value: config.distribution },
  ];
  if (config.distribution === 'claim-paid' && config.claimPriceAr) {
    tags.push({ name: 'StreamVault-Claim-Price-Ar', value: config.claimPriceAr });
  }
  return tags;
}

export function parseDropMetaFromTags(
  tags: Record<string, string | undefined> | undefined
): DropPublishMeta | null {
  if (!tags) return null;
  const mode = tags['StreamVault-Drop-Mode'] as DropDistribution | undefined;
  const supplyRaw = tags['StreamVault-Edition-Supply'];
  if (!mode && !supplyRaw) return null;
  const supply = supplyRaw ? Math.max(1, parseInt(supplyRaw, 10) || 1) : 1;
  const distribution: DropDistribution =
    mode === 'claim-free' || mode === 'claim-paid' || mode === 'hold' ? mode : 'hold';
  const claimPriceAr = tags['StreamVault-Claim-Price-Ar'];
  return {
    supply,
    distribution,
    claimPriceAr,
    claimPagePath: isClaimDrop(distribution) ? undefined : undefined,
  };
}
