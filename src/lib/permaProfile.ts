import Arweave from 'arweave';
import { connect as aoConnect } from '@permaweb/aoconnect';
// @ts-expect-error - package has default export at runtime
import Permaweb from '@permaweb/libs';
import { hbRequest } from './hbNode';

type ProfileOption = {
  id: string;
  timestamp?: number;
};

const PROFILE_READ_FAIL_UNTIL = new Map<string, number>();
const PROFILE_READ_FAIL_TTL_MS = 10 * 60 * 1000;
const PROFILE_COMPUTE_OK_UNTIL = new Map<string, number>();
const PROFILE_COMPUTE_FAIL_UNTIL = new Map<string, number>();
const PROFILE_COMPUTE_TTL_MS = 2 * 60 * 1000;
const LATEST_PROFILE_CACHE = new Map<string, { at: number; data: any }>();
const LATEST_PROFILE_INFLIGHT = new Map<string, Promise<any>>();
const LATEST_PROFILE_TTL_MS = 30 * 1000;
let fallbackReadLibs: any | null = null;

function shouldPreferFallbackReads(): boolean {
  const force = String(import.meta.env.VITE_AO_READ_PREFER_FALLBACK || '').trim();
  if (force === '1') return true;
  if (force === '0') return false;
  const url = String(import.meta.env.VITE_AO_URL || '').toLowerCase();
  return url.includes('localhost') || url.includes('127.0.0.1');
}

function getFallbackReadLibs() {
  if (fallbackReadLibs) return fallbackReadLibs;
  const aoUrl = (import.meta.env.VITE_AO_URL as string | undefined) || '';
  const url =
    (import.meta.env.VITE_AO_READ_URL as string | undefined) ||
    (aoUrl.trim() || undefined) ||
    'https://push.forward.computer';
  const scheduler =
    (import.meta.env.VITE_AO_READ_SCHEDULER as string | undefined) ||
    'n_XZJhUnmldNFo4dhajoPZWhBXuJk-OcQr5JQ49c4Zo';
  const authority =
    (import.meta.env.VITE_AO_READ_AUTHORITY as string | undefined) ||
    'YUsEnCSlxvOMxRd1qG6rkaPwMgi3xOorfDfYJoMDndA';
  const gqlUrl =
    (import.meta.env.VITE_AO_GQL_URL as string | undefined) ||
    'https://ao-search-gateway.goldsky.com/graphql';
  const gateway = gqlUrl.endsWith('/graphql') ? gqlUrl.slice(0, -8) : gqlUrl;
  const ao = aoConnect({
    MODE: 'mainnet',
    URL: url,
    SCHEDULER: scheduler,
  } as any);
  fallbackReadLibs = Permaweb.init({
    ao,
    arweave: Arweave.init({}),
    gateway,
    node: {
      url,
      authority,
      scheduler,
    },
  });
  return fallbackReadLibs;
}

function getReadNodeUrl(): string {
  const aoUrl = (import.meta.env.VITE_AO_URL as string | undefined) || '';
  if (shouldPreferFallbackReads()) {
    return (
      (import.meta.env.VITE_AO_READ_URL as string | undefined) ||
      (aoUrl.trim() || undefined) ||
      'https://push.forward.computer'
    );
  }
  return (
    (import.meta.env.VITE_AO_URL as string | undefined) ||
    'https://push.forward.computer'
  );
}

async function isProcessComputeHealthy(processId: string): Promise<boolean> {
  if (!shouldPreferFallbackReads()) {
    return true;
  }
  const now = Date.now();
  const okUntil = PROFILE_COMPUTE_OK_UNTIL.get(processId) || 0;
  if (okUntil > now) return true;
  const failUntil = PROFILE_COMPUTE_FAIL_UNTIL.get(processId) || 0;
  if (failUntil > now) return false;
  try {
    const base = getReadNodeUrl().replace(/\/+$/, '');
    const res = await hbRequest({
      label: 'profile-health-now',
      url: `${base}/${processId}~process@1.0/now`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const healthy = res.ok;
    if (healthy) PROFILE_COMPUTE_OK_UNTIL.set(processId, now + PROFILE_COMPUTE_TTL_MS);
    else PROFILE_COMPUTE_FAIL_UNTIL.set(processId, now + PROFILE_COMPUTE_TTL_MS);
    return healthy;
  } catch {
    PROFILE_COMPUTE_FAIL_UNTIL.set(processId, now + PROFILE_COMPUTE_TTL_MS);
    return false;
  }
}

function pickFirstString(source: any, keys: string[]): string | null {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function pickFirstAny(source: any, keys: string[]): any {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

export function resolveProfileMediaUrl(raw: any): string | null {
  if (!raw) return null;
  if (typeof raw === 'object') {
    const embedded = pickFirstAny(raw, ['url', 'src', 'href', 'txId', 'id']);
    if (!embedded) return null;
    return resolveProfileMediaUrl(embedded);
  }
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value === 'None') return null;
  if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')) return value;
  if (value.startsWith('ar://')) return `https://arweave.net/${value.slice(5)}`;
  return `https://arweave.net/${value}`;
}

export function getProfileDisplayName(profile: any): string | null {
  return pickFirstString(profile, [
    'displayName',
    'display-name',
    'DisplayName',
    'Display-Name',
    'name',
    'Name',
    'username',
    'userName',
    'Username',
    'handle',
    'Handle',
  ]);
}

export function getProfileHandle(profile: any): string | null {
  return pickFirstString(profile, [
    'handle',
    'Handle',
    'username',
    'userName',
    'Username',
    'displayName',
    'display-name',
    'DisplayName',
    'Display-Name',
  ]);
}

export function getProfileBio(profile: any): string | null {
  return pickFirstString(profile, ['bio', 'Bio', 'description', 'Description', 'desc', 'Desc']);
}

export function getProfileAvatar(profile: any): string | null {
  return resolveProfileMediaUrl(
    pickFirstAny(profile, ['avatar', 'thumbnail', 'image', 'Avatar', 'Thumbnail', 'Image', 'profileImage', 'ProfileImage'])
  );
}

export function getProfileBanner(profile: any): string | null {
  return resolveProfileMediaUrl(
    pickFirstAny(profile, ['banner', 'cover', 'Banner', 'Cover', 'coverImage', 'CoverImage'])
  );
}

export function getProfileOverrideKey(walletAddress: string) {
  return `streamvault:profileId:${walletAddress.toLowerCase()}`;
}

export function getStoredProfileOverrideId(walletAddress: string): string {
  if (!walletAddress || typeof window === 'undefined') return '';
  return localStorage.getItem(getProfileOverrideKey(walletAddress)) || '';
}

export function setStoredProfileOverrideId(walletAddress: string, profileId: string) {
  if (!walletAddress || !profileId || typeof window === 'undefined') return;
  localStorage.setItem(getProfileOverrideKey(walletAddress), profileId);
}

export function clearStoredProfileOverrideId(walletAddress: string) {
  if (!walletAddress || typeof window === 'undefined') return;
  localStorage.removeItem(getProfileOverrideKey(walletAddress));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

function summarizeProfileShape(profile: any) {
  if (!profile || typeof profile !== 'object') return null;
  const store = profile?.store || profile?.Store || null;
  const merged = store && typeof store === 'object' ? { ...profile, ...store } : profile;
  return {
    topLevelKeys: Object.keys(profile).slice(0, 40),
    storeKeys: store && typeof store === 'object' ? Object.keys(store).slice(0, 40) : [],
    identity: {
      id: merged?.id || null,
      owner: merged?.owner || merged?.Owner || merged?.walletAddress || merged?.WalletAddress || null,
      username: merged?.username || merged?.Username || merged?.handle || merged?.Handle || null,
      displayName: merged?.displayName || merged?.DisplayName || merged?.name || merged?.Name || null,
      description: merged?.description || merged?.Description || merged?.bio || merged?.Bio || null,
      thumbnail: merged?.thumbnail || merged?.Thumbnail || null,
      banner: merged?.banner || merged?.Banner || null,
      zoneType: merged?.zoneType || merged?.['Zone-Type'] || null,
      dataProtocol: merged?.dataProtocol || merged?.['Data-Protocol'] || null,
    },
  };
}

export async function inspectProfileReadState(libs: any, profileId: string) {
  const id = String(profileId || '').trim();
  if (!id) throw new Error('Profile id is required.');

  const base = getReadNodeUrl().replace(/\/+$/, '');
  const result: Record<string, any> = {
    profileId: id,
    node: base,
  };

  try {
    const sdk = libs?.getProfileById ? await withTimeout<any>(libs.getProfileById(id), 8000, 'inspectProfile:getProfileById') : null;
    result.sdkGetProfileById = {
      ok: Boolean(sdk?.id),
      summary: summarizeProfileShape(sdk),
      raw: sdk ?? null,
    };
  } catch (error: any) {
    result.sdkGetProfileById = {
      ok: false,
      error: String(error?.message || error),
    };
  }

  try {
    const read = libs?.readProcess
      ? await withTimeout<any>(
        libs.readProcess({
          processId: id,
          action: 'Info',
        }),
        8000,
        'inspectProfile:readProcess'
      )
      : null;
    result.sdkReadProcessInfo = {
      ok: Boolean(read),
      summary: summarizeProfileShape(read),
      raw: read ?? null,
    };
  } catch (error: any) {
    result.sdkReadProcessInfo = {
      ok: false,
      error: String(error?.message || error),
    };
  }

  try {
    const zone = await hbRequest({
      label: 'inspect-profile-zone',
      url: `${base}/${id}~process@1.0/compute/cache/zone`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    result.hbZoneCache = {
      ok: zone.ok,
      status: zone.status,
      summary: summarizeProfileShape(zone.json),
      raw: zone.json ?? zone.text,
    };
  } catch (error: any) {
    result.hbZoneCache = {
      ok: false,
      error: String(error?.message || error),
    };
  }

  try {
    const info = await hbRequest({
      label: 'inspect-profile-info',
      url: `${base}/${id}~process@1.0/as=execution/compute&Action=Info`,
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{}',
    });
    result.hbActionInfo = {
      ok: info.ok,
      status: info.status,
      summary: summarizeProfileShape(info.json),
      raw: info.json ?? info.text,
    };
  } catch (error: any) {
    result.hbActionInfo = {
      ok: false,
      error: String(error?.message || error),
    };
  }

  return result;
}

export async function getProfileOptionsByWallet(
  libs: any,
  walletAddress: string,
  gateway = 'ao-search-gateway.goldsky.com'
): Promise<ProfileOption[]> {
  const activeLibs = shouldPreferFallbackReads() ? (getFallbackReadLibs() || libs) : libs;
  if (!activeLibs?.getGQLData || !walletAddress) return [];
  const [gqlA, gqlB] = await Promise.all([
    activeLibs.getGQLData({
      tags: [
        { name: 'Data-Protocol', values: ['ao'] },
        { name: 'Zone-Type', values: ['User'] },
      ],
      owners: [walletAddress],
      gateway,
    }),
    activeLibs.getGQLData({
      tags: [
        { name: 'data-protocol', values: ['ao'] },
        { name: 'zone-type', values: ['User'] },
      ],
      owners: [walletAddress],
      gateway,
    }),
  ]);

  const deduped = new Map<string, ProfileOption>();
  for (const entry of [...(gqlA?.data || []), ...(gqlB?.data || [])]) {
    const id = entry?.node?.id;
    if (!id) continue;
    const timestamp = entry?.node?.block?.timestamp ? entry.node.block.timestamp * 1000 : undefined;
    const current = deduped.get(id);
    if (!current || (timestamp || 0) > (current.timestamp || 0)) {
      deduped.set(id, { id, timestamp });
    }
  }
  return Array.from(deduped.values()).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export async function getLatestProfileByWallet(
  libs: any,
  walletAddress: string,
  opts?: { timeoutMs?: number; gateway?: string }
): Promise<any> {
  const cached = LATEST_PROFILE_CACHE.get(walletAddress.toLowerCase());
  if (cached && Date.now() - cached.at < LATEST_PROFILE_TTL_MS) return cached.data;
  const inflight = LATEST_PROFILE_INFLIGHT.get(walletAddress.toLowerCase());
  if (inflight) return inflight;

  const run = (async () => {
  if (!libs || !walletAddress) return { id: null };
  const preferFallback = shouldPreferFallbackReads();
  const readLibs = preferFallback ? (getFallbackReadLibs() || libs) : libs;
  const timeoutMs = opts?.timeoutMs ?? 6000;
  const gateway = opts?.gateway ?? 'ao-search-gateway.goldsky.com';

  // First query explicit profile index, then resolve newest profile id.
  const options = await getProfileOptionsByWallet(readLibs, walletAddress, gateway);
  if (options.length > 0 && readLibs.getProfileById) {
    try {
      for (const option of options.slice(0, 8)) {
        const failUntil = PROFILE_READ_FAIL_UNTIL.get(option.id) || 0;
        if (failUntil > Date.now()) continue;
        const healthy = await isProcessComputeHealthy(option.id);
        if (!healthy && !preferFallback) {
          PROFILE_READ_FAIL_UNTIL.set(option.id, Date.now() + PROFILE_READ_FAIL_TTL_MS);
          continue;
        }
        try {
          const candidate = await withTimeout<any>(
            readLibs.getProfileById(option.id),
            timeoutMs,
            'getProfileById'
          );
          if (!candidate?.id) continue;
          const hasIdentity =
            Boolean(getProfileDisplayName(candidate)) ||
            Boolean(getProfileHandle(candidate)) ||
            Boolean(getProfileBio(candidate)) ||
            Boolean(getProfileAvatar(candidate));
          if (hasIdentity) {
            LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: candidate });
            return candidate;
          }
        } catch {
          PROFILE_READ_FAIL_UNTIL.set(option.id, Date.now() + PROFILE_READ_FAIL_TTL_MS);
        }
      }
      const firstHealthy = options.find((o) => {
        const failUntil = PROFILE_READ_FAIL_UNTIL.get(o.id) || 0;
        return failUntil <= Date.now();
      });
      if (firstHealthy) {
        const latest = await withTimeout<any>(readLibs.getProfileById(firstHealthy.id), timeoutMs, 'getProfileById');
        if (latest?.id) {
          LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: latest });
          return latest;
        }
      }
    } catch (e: any) {
      const firstId = options[0]?.id;
      if (firstId) PROFILE_READ_FAIL_UNTIL.set(firstId, Date.now() + PROFILE_READ_FAIL_TTL_MS);
      // Continue to SDK helper fallback.
    }
  }

  // Fallback to SDK helper.
  if (readLibs.getProfileByWalletAddress) {
    try {
      const sdkProfile: any = await withTimeout<any>(
        readLibs.getProfileByWalletAddress(walletAddress),
        timeoutMs,
        'getProfileByWalletAddress'
      );
      if (sdkProfile?.id) {
        LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: sdkProfile });
        return sdkProfile;
      }
    } catch {
      // Fallback below.
    }
  }
  const empty = { id: null };
  LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: empty });
  return empty;
  })();
  LATEST_PROFILE_INFLIGHT.set(walletAddress.toLowerCase(), run);
  try {
    return await run;
  } finally {
    LATEST_PROFILE_INFLIGHT.delete(walletAddress.toLowerCase());
  }
}

export async function getProfileByIdSafe(
  libs: any,
  profileId: string,
  opts?: { timeoutMs?: number }
): Promise<any | null> {
  const id = String(profileId || '').trim();
  if (!libs || !id) return null;
  const timeoutMs = opts?.timeoutMs ?? 6000;
  const failUntil = PROFILE_READ_FAIL_UNTIL.get(id) || 0;
  if (failUntil > Date.now()) return null;
  const preferFallback = shouldPreferFallbackReads();
  const readLibs = preferFallback ? (getFallbackReadLibs() || libs) : libs;
  if (!readLibs?.getProfileById) return null;
  const healthy = await isProcessComputeHealthy(id);
  if (!healthy && !preferFallback) {
    PROFILE_READ_FAIL_UNTIL.set(id, Date.now() + PROFILE_READ_FAIL_TTL_MS);
    return null;
  }
  try {
    const profile = await withTimeout<any>(readLibs.getProfileById(id), timeoutMs, 'getProfileByIdSafe');
    return profile?.id ? profile : null;
  } catch {
    PROFILE_READ_FAIL_UNTIL.set(id, Date.now() + PROFILE_READ_FAIL_TTL_MS);
    return null;
  }
}

export async function getSelectedOrLatestProfileByWallet(
  libs: any,
  walletAddress: string,
  opts?: { timeoutMs?: number; gateway?: string; useOverride?: boolean }
): Promise<any> {
  if (!libs || !walletAddress) return { id: null };
  const timeoutMs = opts?.timeoutMs ?? 7000;
  const useOverride = opts?.useOverride ?? false;
  if (!useOverride) {
    clearStoredProfileOverrideId(walletAddress);
    return getLatestProfileByWallet(libs, walletAddress, opts);
  }
  const selectedId = getStoredProfileOverrideId(walletAddress);
  if (selectedId) {
    try {
      const selected = await getProfileByIdSafe(libs, selectedId, { timeoutMs });
      if (selected?.id) return selected;
    } catch {
      // Keep the override during indexing lag for freshly created profiles.
    }
  }
  return getLatestProfileByWallet(libs, walletAddress, opts);
}
