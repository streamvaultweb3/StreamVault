export type StreamVaultSdkOptions = {
    permaweb?: any;
    ario?: {
        resolveArNSName(args: {
            name: string;
        }): Promise<{
            txId?: string;
            processId?: string;
        } | null>;
    };
    gatewayUrl?: string;
    gqlUrl?: string;
    aoGatewayUrl?: string;
    hbReadNodes?: string[];
};
export type ProfileAssetRef = {
    id: string;
    quantity: string;
};
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
export declare function createStreamVaultClient(options?: StreamVaultSdkOptions): {
    getProfileById(profileId: string): Promise<StreamVaultProfile | null>;
    getProfileByWallet(walletAddress: string): Promise<StreamVaultProfile | null>;
    getProfileByHandle(_handle: string): Promise<StreamVaultProfile | null>;
    resolveArNSProfile(name: string): Promise<StreamVaultProfile | null>;
    resolveProfile(ref: string): Promise<StreamVaultProfileResolution>;
    getTracksByWallet(walletAddress: string, args?: {
        limit?: number;
    }): Promise<StreamVaultTrack[]>;
    getTracksByProfile(profile: StreamVaultProfile, args?: {
        limit?: number;
    }): Promise<StreamVaultTrack[]>;
    getTrendingTracks(args?: {
        limit?: number;
    }): Promise<StreamVaultTrack[]>;
    getAtomicAsset(assetId: string): Promise<StreamVaultAtomicAsset>;
    getAssetUcmAsks(assetId: string): Promise<UcmActiveOrder[]>;
    getAssetUcmMarketStatus(assetId: string): Promise<AssetUcmMarketStatus>;
    getMarketplaceListings(_args?: {
        limit?: number;
    }): Promise<MarketplaceListing[]>;
    getStreamUrls(audioTxId: string): string[];
    getPreferredStreamUrl(audioTxId: string): string;
};
export type StreamVaultClient = ReturnType<typeof createStreamVaultClient>;
export {};
//# sourceMappingURL=index.d.ts.map