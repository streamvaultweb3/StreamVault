import { connect, createDataItemSigner } from '@permaweb/aoconnect';
import type { UdlConfig, RoyaltySplit } from './udl';

const ao = connect({ MODE: 'legacy' } as any);

const MUSIC_REGISTRY_PROCESS =
  (import.meta as any).env?.VITE_AO_MUSIC_REGISTRY_PROCESS ||
  (import.meta as any).env?.VITE_AO_MUSIC_REGISTRY ||
  // Fallback to the known deployed process id so the app works
  // out of the box if env vars are not set.
  'trua-MoaYpxNs5i9fJhe4R79t_AdAmkGF9xNB_IMj34';

export interface RegisteredTrackRecord {
  assetId: string;
  audioTxId: string;
  creator: string;
  udl?: UdlConfig;
  splits?: RoyaltySplit[];
  tags?: Record<string, string>;
  createdAt?: number;
}

export async function registerTrackOnAO(args: {
  assetId: string;
  audioTxId: string;
  creator: string;
  udl?: UdlConfig;
  splits?: RoyaltySplit[];
  tags?: Record<string, string>;
}): Promise<void> {
  if (!MUSIC_REGISTRY_PROCESS) {
    console.warn('[ao] MUSIC_REGISTRY_PROCESS env not set; skipping on-chain registry');
    return;
  }

  const payload = {
    Action: 'RegisterTrack',
    AssetId: args.assetId,
    AudioTxId: args.audioTxId,
    Creator: args.creator,
    UDL: args.udl,
    Splits: args.splits,
    Tags: args.tags,
    CreatedAt: Math.floor(Date.now() / 1000),
  };

  const win = typeof window !== 'undefined' ? (window as any) : null;
  const wallet = win?.arweaveWallet;
  if (!wallet) {
    console.warn('[ao] No arweaveWallet signer available; skipping RegisterTrack message');
    return;
  }

  const signer = createDataItemSigner(wallet);

  await ao.message({
    process: MUSIC_REGISTRY_PROCESS,
    data: JSON.stringify(payload),
    signer,
  });
}

export async function searchTracksOnAO(query: {
  creator?: string;
  license?: string;
  aiUse?: string;
  tagName?: string;
  tagValue?: string;
}): Promise<RegisteredTrackRecord[]> {
  if (!MUSIC_REGISTRY_PROCESS) {
    console.warn('[ao] MUSIC_REGISTRY_PROCESS env not set; search will be empty');
    return [];
  }

  const res: any = await ao.dryrun({
    process: MUSIC_REGISTRY_PROCESS,
    data: JSON.stringify({
      Action: 'SearchTracks',
      Query: {
        ...(query.creator && { Creator: query.creator }),
        ...(query.license && { License: query.license }),
        ...(query.aiUse && { AIUse: query.aiUse }),
        ...(query.tagName && query.tagValue && { TagName: query.tagName, TagValue: query.tagValue }),
      },
    }),
  });

  const message = res.Messages?.[0];
  if (!message || !message.Data) return [];
  try {
    const parsed = JSON.parse(message.Data);
    return parsed.Results as RegisteredTrackRecord[];
  } catch (e) {
    console.warn('[ao] Failed to parse SearchTracks result', e);
    return [];
  }
}
