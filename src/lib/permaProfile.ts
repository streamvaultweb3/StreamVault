import Arweave from 'arweave';
import {
  arweaveGraphqlEndpoint,
  arweavePublicDataUrls,
  preferredArweaveStreamUrl,
} from './arweaveDataGateway';
import { connect as aoConnect } from '@permaweb/aoconnect';
// @ts-expect-error - package has default export at runtime
import Permaweb from '@permaweb/libs';
import { resolveAoNode, resolveHbReadNodeUrls, LEGACY_AO_SCHEDULER } from './aoNode';
import { hydrateProcessOnPortalAndBazar } from './hbHydration';
import { hbRequest } from './hbNode';

type ProfileOption = {
  id: string;
  timestamp?: number;
  scheduler?: string | null;
};

const PROFILE_READ_FAIL_UNTIL = new Map<string, number>();
const PROFILE_READ_FAIL_TTL_MS = 10 * 60 * 1000;
const PROFILE_COMPUTE_OK_UNTIL = new Map<string, number>();
const PROFILE_COMPUTE_FAIL_UNTIL = new Map<string, number>();
const PROFILE_COMPUTE_TTL_MS = 2 * 60 * 1000;
const LATEST_PROFILE_CACHE = new Map<string, { at: number; data: any }>();
const LATEST_PROFILE_INFLIGHT = new Map<string, Promise<any>>();
const LATEST_PROFILE_TTL_MS = 30 * 1000;
const LATEST_PROFILE_EMPTY_TTL_MS = 5 * 1000;
const PROFILE_SCHEDULER_CACHE = new Map<string, string | null>();
const PROFILE_SPAWN_INDEX_CACHE = new Map<string, { at: number; data: ProfileSpawnIndex | null }>();
const PROFILE_SPAWN_INDEX_TTL_MS = 5 * 60 * 1000;
let fallbackReadLibs: any | null = null;

type ProfileSpawnIndex = {
  profileId: string;
  walletAddress: string | null;
  scheduler: string | null;
  displayName: string | null;
  username: string | null;
  description: string | null;
  thumbnail: string | null;
  banner: string | null;
};
const readLibsByUrl = new Map<string, any>();

function normalizeNodeUrl(url: string | undefined | null): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

function getPrimaryAppNodeUrl(): string {
  return normalizeNodeUrl(resolveAoNode().url);
}

function getProfileFallbackReadUrl(): string {
  return (
    normalizeNodeUrl(import.meta.env.VITE_AO_READ_URL as string | undefined) ||
    getPrimaryAppNodeUrl()
  );
}

function getProfileFallbackReadAuthority(): string {
  return (
    String(import.meta.env.VITE_AO_READ_AUTHORITY || '').trim() ||
    resolveAoNode().authority
  );
}

function shouldPreferFallbackReads(): boolean {
  const force = String(import.meta.env.VITE_AO_READ_PREFER_FALLBACK || '').trim();
  if (force === '1') return true;
  if (force === '0') return false;
  const url = String(import.meta.env.VITE_AO_URL || '').toLowerCase();
  return url.includes('localhost') || url.includes('127.0.0.1');
}

function getFallbackReadLibs() {
  if (fallbackReadLibs) return fallbackReadLibs;
  const url = getProfileFallbackReadUrl();
  const node = resolveAoNode();
  const scheduler =
    (import.meta.env.VITE_AO_READ_SCHEDULER as string | undefined) ||
    node.scheduler;
  const authority = getProfileFallbackReadAuthority();
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
  if (shouldPreferFallbackReads()) {
    return getProfileFallbackReadUrl();
  }
  return getPrimaryAppNodeUrl();
}

/** Portal HB reads (default). Local dev can override via VITE_AO_READ_URL. */
function resolveProfileReadLibs(appLibs: any): { primary: any; alternate: any | null } {
  if (shouldPreferFallbackReads()) {
    return { primary: getFallbackReadLibs(), alternate: appLibs };
  }
  return { primary: appLibs, alternate: null };
}

/** Use for zone/asset Info reads (atomic assets, profile tokens). */
export function getProfileReadLibs(appLibs: any): any {
  return resolveProfileReadLibs(appLibs).primary;
}

/** Clear read backoff after a successful zone write so refresh can succeed. */
export function clearProfileReadBackoff(profileId: string) {
  const id = String(profileId || '').trim();
  if (!id) return;
  PROFILE_READ_FAIL_UNTIL.delete(id);
  PROFILE_COMPUTE_FAIL_UNTIL.delete(id);
}

export function invalidateLatestProfileCache(walletAddress?: string | null) {
  if (!walletAddress) return;
  LATEST_PROFILE_CACHE.delete(walletAddress.toLowerCase());
}

function getTagValue(tags: Array<{ name?: string; value?: string }>, names: string[]): string | null {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const tag of tags || []) {
    const name = String(tag?.name || '').toLowerCase();
    const value = String(tag?.value || '').trim();
    if (wanted.has(name) && value) return value;
  }
  return null;
}

function profileHasIdentity(profile: any): boolean {
  return (
    Boolean(getProfileDisplayName(profile)) ||
    Boolean(getProfileHandle(profile)) ||
    Boolean(getProfileBio(profile)) ||
    Boolean(getProfileAvatar(profile))
  );
}

function scheduleProfileHydration(profileId: string) {
  void hydrateProcessOnPortalAndBazar(profileId).catch(() => {});
}

/** Spawn tx tags when HyperBEAM zone reads time out or are unavailable. */
async function fetchProfileSpawnIndex(profileId: string): Promise<ProfileSpawnIndex | null> {
  const id = String(profileId || '').trim();
  if (!id) return null;

  const cached = PROFILE_SPAWN_INDEX_CACHE.get(id);
  if (cached && Date.now() - cached.at < PROFILE_SPAWN_INDEX_TTL_MS) return cached.data;

  try {
    const query = `
      query StreamVaultProfileSpawnIndex($ids: [ID!]!) {
        transactions(ids: $ids, first: 1) {
          edges {
            node {
              id
              owner { address }
              tags { name value }
            }
          }
        }
      }
    `;
    const res = await fetch(arweaveGraphqlEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { ids: [id] } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const node = json?.data?.transactions?.edges?.[0]?.node;
    if (!node?.id) {
      PROFILE_SPAWN_INDEX_CACHE.set(id, { at: Date.now(), data: null });
      return null;
    }
    const tags = node.tags || [];
    const index: ProfileSpawnIndex = {
      profileId: String(node.id),
      walletAddress: String(node?.owner?.address || '').trim() || null,
      scheduler: getTagValue(tags, ['Scheduler', 'Scheduler-Location', 'scheduler', 'scheduler-location']),
      displayName: getTagValue(tags, ['Bootloader-DisplayName', 'Display-Name', 'display-name', 'DisplayName']),
      username: getTagValue(tags, ['Bootloader-Username', 'Username', 'username', 'Handle', 'handle']),
      description: getTagValue(tags, ['Bootloader-Description', 'Description', 'description']),
      thumbnail: getTagValue(tags, ['Bootloader-Thumbnail', 'Thumbnail', 'thumbnail', 'Avatar', 'avatar']),
      banner: getTagValue(tags, ['Bootloader-Banner', 'Banner', 'banner', 'Cover', 'cover']),
    };
    PROFILE_SPAWN_INDEX_CACHE.set(id, { at: Date.now(), data: index });
    if (index.scheduler) PROFILE_SCHEDULER_CACHE.set(id, index.scheduler);
    return index;
  } catch {
    PROFILE_SPAWN_INDEX_CACHE.set(id, { at: Date.now(), data: null });
    return null;
  }
}

function buildProfileFromSpawnIndex(
  index: ProfileSpawnIndex,
  walletHint?: string | null
): any | null {
  const walletAddress = index.walletAddress || (walletHint ? String(walletHint).trim() : null) || null;
  const profile = {
    id: index.profileId,
    walletAddress,
    owner: walletAddress,
    scheduler: index.scheduler,
    displayName: index.displayName,
    username: index.username,
    description: index.description,
    thumbnail: index.thumbnail,
    banner: index.banner,
    indexedFromSpawn: true,
  };
  return profileHasIdentity(profile) || profile.id ? profile : null;
}

async function readProfileFromSpawnIndex(
  profileId: string,
  walletHint?: string | null
): Promise<any | null> {
  const index = await fetchProfileSpawnIndex(profileId);
  if (!index) return null;
  const profile = buildProfileFromSpawnIndex(index, walletHint);
  if (profile?.id) {
    clearProfileReadBackoff(profile.id);
    scheduleProfileHydration(profile.id);
  }
  return profile;
}

function readProfileSchedulerField(profile: any): string | null {
  const value = profile?.scheduler ?? profile?.Scheduler ?? profile?.['Scheduler-Location'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Resolve the scheduler used when this profile zone was spawned. */
export async function resolveProfileScheduler(profileOrId: any): Promise<string | null> {
  const defaultScheduler = resolveAoNode().scheduler;
  const profileId =
    typeof profileOrId === 'string'
      ? profileOrId.trim()
      : String(profileOrId?.id || profileOrId?.profileId || '').trim();
  if (!profileId) return defaultScheduler;

  const fromProfile = typeof profileOrId === 'string' ? null : readProfileSchedulerField(profileOrId);
  if (fromProfile) return fromProfile;

  if (PROFILE_SCHEDULER_CACHE.has(profileId)) return PROFILE_SCHEDULER_CACHE.get(profileId) || defaultScheduler;

  try {
    const query = `
      query StreamVaultProfileScheduler($ids: [ID!]!) {
        transactions(ids: $ids, first: 1) {
          edges {
            node {
              tags { name value }
            }
          }
        }
      }
    `;
    const res = await fetch(arweaveGraphqlEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { ids: [profileId] } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const tags = json?.data?.transactions?.edges?.[0]?.node?.tags || [];
    const scheduler = getTagValue(tags, [
      'Scheduler',
      'Scheduler-Location',
      'scheduler',
      'scheduler-location',
    ]);
    const resolved = scheduler || defaultScheduler;
    PROFILE_SCHEDULER_CACHE.set(profileId, resolved);
    return resolved;
  } catch {
    PROFILE_SCHEDULER_CACHE.set(profileId, defaultScheduler);
    return defaultScheduler;
  }
}

export async function resolveProfileZoneMediaId(libs: any, value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  if (typeof libs?.resolveTransaction === 'function') {
    try {
      return await libs.resolveTransaction(value);
    } catch {
      // fall through to raw value
    }
  }
  return value;
}

function getReadLibsForNodeUrl(nodeUrl: string, appLibs: any): any {
  const url = normalizeNodeUrl(nodeUrl);
  if (!url) return appLibs;
  if (appLibs && url === getPrimaryAppNodeUrl()) return appLibs;
  const cached = readLibsByUrl.get(url);
  if (cached) return cached;
  const node = resolveAoNode();
  const scheduler =
    (import.meta.env.VITE_AO_READ_SCHEDULER as string | undefined) ||
    node.scheduler;
  const authority = getProfileFallbackReadAuthority();
  const gqlUrl =
    (import.meta.env.VITE_AO_GQL_URL as string | undefined) ||
    'https://ao-search-gateway.goldsky.com/graphql';
  const gateway = gqlUrl.endsWith('/graphql') ? gqlUrl.slice(0, -8) : gqlUrl;
  const ao = aoConnect({
    MODE: 'mainnet',
    URL: url,
    SCHEDULER: scheduler,
  } as any);
  const libs = Permaweb.init({
    ao,
    arweave: Arweave.init({}),
    gateway,
    node: {
      url,
      authority,
      scheduler,
    },
  });
  readLibsByUrl.set(url, libs);
  return libs;
}

function parseJsonObject(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace <= 0) return null;
    try {
      return JSON.parse(text.slice(0, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

async function fetchHyperbeamJsonStream(url: string, timeoutMs = 7000): Promise<any | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const decoder = new TextDecoder();
  let text = '';
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'accept-bundle': 'true',
        'require-codec': 'application/json',
      },
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    if (!reader) {
      text = await res.text();
      return parseJsonObject(text);
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return parseJsonObject(text);
  } catch {
    return parseJsonObject(text);
  } finally {
    window.clearTimeout(timer);
  }
}

function linkedId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{43}$/.test(trimmed) ? trimmed : null;
}

function profileFromHyperbeamStore(profileId: string, zone: any, store: any): any | null {
  if (!store || typeof store !== 'object') return null;
  return {
    id: profileId,
    owner: zone?.Owner || zone?.owner || null,
    assets: [],
    roles: [],
    invites: [],
    version: zone?.Version || zone?.version || null,
    authorities: [],
    ...store,
  };
}

async function readProfileByPortalLinks(profileId: string): Promise<any | null> {
  for (const nodeBase of resolveHbReadNodeUrls()) {
    const base = normalizeNodeUrl(nodeBase);
    if (!base) continue;
    try {
      const compute = await fetchHyperbeamJsonStream(`${base}/${profileId}~process@1.0/compute`, 7000);
      const zoneLink = linkedId(compute?.['zone+link']);
      if (!zoneLink) continue;
      const zone = await fetchHyperbeamJsonStream(`${base}/${zoneLink}`, 7000);
      const storeLink = linkedId(zone?.['Store+link']);
      if (!storeLink) continue;
      const store = await fetchHyperbeamJsonStream(`${base}/${storeLink}`, 7000);
      const profile = profileFromHyperbeamStore(profileId, zone, store);
      if (profile?.id) return profile;
    } catch {
      // try next node
    }
  }
  return null;
}

async function readProfileById(
  appLibs: any,
  profileId: string,
  timeoutMs: number,
  label: string
): Promise<any | null> {
  const nodeUrls = resolveHbReadNodeUrls();
  const perNodeTimeout = Math.max(3000, Math.floor(timeoutMs / Math.max(nodeUrls.length, 1)));
  for (let i = 0; i < nodeUrls.length; i++) {
    const nodeUrl = nodeUrls[i];
    const reader = getReadLibsForNodeUrl(nodeUrl, appLibs);
    if (!reader?.getProfileById) continue;
    const nodeTimeout = i === 0 ? timeoutMs : Math.min(perNodeTimeout, 5000);
    try {
      const profile = await withTimeout<any>(
        reader.getProfileById(profileId),
        nodeTimeout,
        `${label}:${nodeUrl}`
      );
      if (profile?.id) return profile;
    } catch {
      // try next HyperBEAM node
    }
  }
  const { alternate } = resolveProfileReadLibs(appLibs);
  if (alternate?.getProfileById) {
    try {
      const profile = await withTimeout<any>(
        alternate.getProfileById(profileId),
        Math.min(timeoutMs, 3500),
        `${label}:alternate`
      );
      if (profile?.id) return profile;
    } catch {
      // fall through
    }
  }
  const fromLinks = await readProfileByPortalLinks(profileId);
  if (fromLinks?.id) return fromLinks;
  return (await readProfileFromSpawnIndex(profileId)) || null;
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
  if (value.startsWith('data:')) return value;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    const fromUrl = value.match(/\/([A-Za-z0-9_-]{43})(?:$|[?#/])/);
    if (fromUrl?.[1] && /:\/\/(?:[^/]+\.)?(?:arweave\.net|arweave\.dev|g8way\.io|ar-io\.dev|permagate\.io|turbo-gateway\.com)\//i.test(value)) {
      return resolveProfileMediaUrls(fromUrl[1])[0] || value;
    }
    return value;
  }
  const id = value.startsWith('ar://') ? value.slice(5) : value;
  if (/^[A-Za-z0-9_-]{43}$/.test(id)) return preferredArweaveStreamUrl(id);
  if (value.startsWith('ar://')) return preferredArweaveStreamUrl(id);
  return preferredArweaveStreamUrl(value);
}

export function resolveProfileMediaUrls(raw: any): string[] {
  if (!raw) return [];
  if (typeof raw === 'object') {
    const embedded = pickFirstAny(raw, ['url', 'src', 'href', 'txId', 'id']);
    return embedded ? resolveProfileMediaUrls(embedded) : [];
  }
  if (typeof raw !== 'string') return [];
  const value = raw.trim();
  if (!value || value === 'None') return [];
  if (value.startsWith('data:')) return [value];
  if (value.startsWith('http://') || value.startsWith('https://')) {
    const fromUrl = value.match(/\/([A-Za-z0-9_-]{43})(?:$|[?#/])/);
    if (fromUrl?.[1] && /:\/\/(?:[^/]+\.)?(?:arweave\.net|arweave\.dev|g8way\.io|ar-io\.dev|permagate\.io|turbo-gateway\.com)\//i.test(value)) {
      return resolveProfileMediaUrls(fromUrl[1]);
    }
    return [value];
  }
  const id = value.startsWith('ar://') ? value.slice(5) : value;
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return arweavePublicDataUrls(id);
  return arweavePublicDataUrls(id);
}

export function getProfileDisplayName(profile: any): string | null {
  return pickFirstString(profile, [
    'displayName',
    'display-name',
    'DisplayName',
    'Display-Name',
    'name',
    'Name',
  ]);
}

export function getProfileHandle(profile: any): string | null {
  return pickFirstString(profile, [
    'handle',
    'Handle',
    'username',
    'userName',
    'Username',
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

/** Prefer Portal-scheduler zones (hydrate on hb.portalinto.com) over legacy app-1 spawns. */
async function sortProfileOptionsForPortal(options: ProfileOption[]): Promise<ProfileOption[]> {
  const currentScheduler = resolveAoNode().scheduler;
  const enriched = await Promise.all(
    options.map(async (option) => ({
      ...option,
      scheduler: await resolveProfileScheduler(option.id),
    }))
  );
  return enriched.sort((a, b) => {
    const aPortal = a.scheduler === currentScheduler ? 1 : 0;
    const bPortal = b.scheduler === currentScheduler ? 1 : 0;
    if (aPortal !== bPortal) return bPortal - aPortal;
    return (b.timestamp || 0) - (a.timestamp || 0);
  });
}

export async function getLatestProfileByWallet(
  libs: any,
  walletAddress: string,
  opts?: { timeoutMs?: number; gateway?: string }
): Promise<any> {
  const cached = LATEST_PROFILE_CACHE.get(walletAddress.toLowerCase());
  if (cached) {
    const ttl = cached.data?.id ? LATEST_PROFILE_TTL_MS : LATEST_PROFILE_EMPTY_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.data;
  }
  const inflight = LATEST_PROFILE_INFLIGHT.get(walletAddress.toLowerCase());
  if (inflight) return inflight;

  const run = (async () => {
  if (!libs || !walletAddress) return { id: null };
  const preferFallback = shouldPreferFallbackReads();
  const readLibs = preferFallback ? (getFallbackReadLibs() || libs) : libs;
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const gateway = opts?.gateway ?? 'ao-search-gateway.goldsky.com';

  // Resolve readable profile — Portal scheduler first, then newest.
  const options = await sortProfileOptionsForPortal(
    await getProfileOptionsByWallet(readLibs, walletAddress, gateway)
  );
  if (options.length > 0) {
    try {
      for (const option of options.slice(0, 5)) {
        const failUntil = PROFILE_READ_FAIL_UNTIL.get(option.id) || 0;
        if (failUntil > Date.now()) {
          const indexedWhileCooling = await readProfileFromSpawnIndex(option.id, walletAddress);
          if (indexedWhileCooling?.id && profileHasIdentity(indexedWhileCooling)) {
            LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: indexedWhileCooling });
            return indexedWhileCooling;
          }
          continue;
        }
        const healthy = await isProcessComputeHealthy(option.id);
        if (!healthy && !preferFallback) {
          const indexedWhenUnhealthy = await readProfileFromSpawnIndex(option.id, walletAddress);
          if (indexedWhenUnhealthy?.id && profileHasIdentity(indexedWhenUnhealthy)) {
            LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: indexedWhenUnhealthy });
            return indexedWhenUnhealthy;
          }
          PROFILE_READ_FAIL_UNTIL.set(option.id, Date.now() + PROFILE_READ_FAIL_TTL_MS);
          continue;
        }
        const candidate =
          (await readProfileById(libs, option.id, timeoutMs, 'getProfileById')) ||
          (await readProfileFromSpawnIndex(option.id, walletAddress));
        if (!candidate?.id) {
          PROFILE_READ_FAIL_UNTIL.set(option.id, Date.now() + PROFILE_READ_FAIL_TTL_MS);
          continue;
        }
        if (profileHasIdentity(candidate)) {
          LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: candidate });
          return candidate;
        }
      }
      const firstHealthy = options.find((o) => {
        const failUntil = PROFILE_READ_FAIL_UNTIL.get(o.id) || 0;
        return failUntil <= Date.now();
      });
      if (firstHealthy) {
        const latest =
          (await readProfileById(libs, firstHealthy.id, timeoutMs, 'getProfileById')) ||
          (await readProfileFromSpawnIndex(firstHealthy.id, walletAddress));
        if (latest?.id) {
          LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: latest });
          return latest;
        }
      }
    } catch (e: any) {
      const firstId = options[0]?.id;
      if (firstId) {
        const indexedOnError = await readProfileFromSpawnIndex(firstId, walletAddress);
        if (indexedOnError?.id) {
          LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: indexedOnError });
          return indexedOnError;
        }
        PROFILE_READ_FAIL_UNTIL.set(firstId, Date.now() + PROFILE_READ_FAIL_TTL_MS);
      }
      // Continue to SDK helper fallback.
    }
  }

  // Fallback to SDK helper.
  const { primary, alternate } = resolveProfileReadLibs(libs);
  const sdkReaders = [primary, alternate].filter(Boolean);
  for (const reader of sdkReaders) {
    if (!reader?.getProfileByWalletAddress) continue;
    try {
      const sdkProfile: any = await withTimeout<any>(
        reader.getProfileByWalletAddress(walletAddress),
        timeoutMs,
        'getProfileByWalletAddress'
      );
      if (sdkProfile?.id) {
        if (!profileHasIdentity(sdkProfile)) {
          const indexed = await readProfileFromSpawnIndex(sdkProfile.id, walletAddress);
          if (indexed?.id) {
            LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: indexed });
            return indexed;
          }
        }
        LATEST_PROFILE_CACHE.set(walletAddress.toLowerCase(), { at: Date.now(), data: sdkProfile });
        return sdkProfile;
      }
    } catch {
      // try next reader
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
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const failUntil = PROFILE_READ_FAIL_UNTIL.get(id) || 0;
  if (failUntil > Date.now()) return null;
  const preferFallback = shouldPreferFallbackReads();
  if (preferFallback) {
    const healthy = await isProcessComputeHealthy(id);
    if (!healthy) {
      PROFILE_READ_FAIL_UNTIL.set(id, Date.now() + PROFILE_READ_FAIL_TTL_MS);
      return null;
    }
  }
  const profile = await readProfileById(libs, id, timeoutMs, 'getProfileByIdSafe');
  if (profile?.id) return profile;
  const indexed = await readProfileFromSpawnIndex(id);
  if (indexed?.id) return indexed;
  PROFILE_READ_FAIL_UNTIL.set(id, Date.now() + PROFILE_READ_FAIL_TTL_MS);
  return null;
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

export type ProfileAssetRef = { id: string; quantity: string };

export function collectProfileAssetRefs(profile: any): ProfileAssetRef[] {
  const byId = new Map<string, string>();
  for (const raw of [profile?.assets, profile?.Assets]) {
    const arr = Array.isArray(raw) ? raw : [];
    for (const row of arr) {
      const id = String(row?.id || row?.Id || '').trim();
      if (!id) continue;
      const quantity = String(
        row?.quantity ?? row?.Quantity ?? row?.balance ?? row?.Balance ?? row?.amount ?? '1'
      );
      byId.set(id, quantity);
    }
  }
  return Array.from(byId.entries()).map(([id, quantity]) => ({ id, quantity }));
}

/** True when profile was spawned on legacy scheduler (Transfer vs Run-Action for zone actions). */
export function isLegacyIndexedProfile(profile: any): boolean {
  const scheduler = String(profile?.scheduler ?? profile?.Scheduler ?? '').trim();
  return scheduler === LEGACY_AO_SCHEDULER;
}

/** Arweave wallet + AO process ids are 43-char base64url (includes `_` and `-`). */
export function isLikelyArweaveAddressRef(ref: string | undefined): boolean {
  if (!ref || ref.length !== 43) return false;
  return /^[A-Za-z0-9_-]+$/.test(ref);
}

/** Prefer permaweb zone id in nav/share URLs; fall back to wallet route while resolving. */
export function resolveProfilePublicPath(args: {
  walletAddress?: string | null;
  profileId?: string | null;
  cachedProfileId?: string | null;
}): string {
  const zoneId = String(args.profileId || args.cachedProfileId || '').trim();
  if (zoneId) return `/profile/${zoneId}`;
  const wallet = String(args.walletAddress || '').trim();
  if (wallet) return `/profile/${wallet}`;
  return '/profile';
}

export function inferProfileWalletAddress(profile: any, fallback?: string | null): string | null {
  const owner =
    profile?.walletAddress ||
    profile?.WalletAddress ||
    profile?.owner ||
    profile?.Owner ||
    null;
  if (typeof owner === 'string' && owner.trim()) return owner.trim();
  if (fallback && typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  return null;
}

/** True when a loaded profile zone belongs to the connected wallet address. */
export function profileOwnedByWallet(
  profile: any,
  walletAddress: string | null | undefined
): boolean {
  if (!profile?.id || !walletAddress) return false;
  const owner = inferProfileWalletAddress(profile, walletAddress);
  return Boolean(owner && owner.toLowerCase() === walletAddress.toLowerCase());
}

/** When route is a wallet address but profile resolved to a zone id, use the zone id URL. */
export function shouldCanonicalizeProfileRoute(routeRef: string | undefined, profile: any): string | null {
  const profileId = String(profile?.id || '').trim();
  if (!profileId || !routeRef || profileId === routeRef) return null;
  if (!isLikelyArweaveAddressRef(routeRef)) return null;
  const owner = inferProfileWalletAddress(profile, routeRef);
  if (!owner || owner.toLowerCase() !== routeRef.toLowerCase()) return null;
  return `/profile/${profileId}`;
}
