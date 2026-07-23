import {
  clearProfileReadBackoff,
  getProfileByIdSafe,
  invalidateLatestProfileCache,
  resolveProfileZoneMediaId,
} from './permaProfile';
import { createResilientAoFetch } from './aoFetch';
import { resolveProfileZoneWriteNodeUrls } from './aoNode';

const ARWEAVE_TX_ID_RE = /^[A-Za-z0-9_-]{43}$/;
/** HB push/sign — wait for Wander + push response. */
const PROFILE_PUSH_TIMEOUT_MS = 120_000;
/** Per-node push attempt — Portal /push often hangs; try next node quickly. */
const PROFILE_PUSH_ATTEMPT_TIMEOUT_MS = 25_000;
/** Poll Portal HB until zone store reflects the edit. */
const PROFILE_CHAIN_CONFIRM_TIMEOUT_MS = 120_000;
const PROFILE_CHAIN_CONFIRM_POLL_MS = 3_000;
/** Media upload via Wander DISPATCH before the zone push. */
const PROFILE_MEDIA_TIMEOUT_MS = 180_000;

const profileDebug =
  import.meta.env.DEV &&
  String(import.meta.env.VITE_DEBUG_PROFILE || import.meta.env.VITE_DEBUG_PERMAWEB || '') === '1';

function profileLog(...args: unknown[]) {
  if (profileDebug) console.info('[profile:write]', ...args);
}


export type ProfileEditForm = {
  username: string;
  displayName: string;
  description: string;
  audiusHandle?: string;
  thumbnail?: File | null;
  banner?: File | null;
  thumbnailValue?: string | null;
  bannerValue?: string | null;
  removeThumbnail?: boolean;
  removeBanner?: boolean;
};

export type PermawebProfileArgs = {
  username: string;
  displayName: string;
  description: string;
  thumbnail?: string;
  banner?: string;
};

function pickProfileField(profile: any, keys: string[]): string | null {
  for (const key of keys) {
    const value = profile?.[key];
    if (typeof value === 'string' && value.trim() && value.trim() !== 'None') return value.trim();
  }
  return null;
}

/** Raw tx id / data URL for permaweb-libs — not a resolved https://arweave.net URL. */
export function extractRawProfileMediaRef(
  profile: any,
  kind: 'thumbnail' | 'banner'
): string | null {
  const keys =
    kind === 'thumbnail'
      ? ['Thumbnail', 'thumbnail', 'Avatar', 'avatar', 'Image', 'image', 'profileImage', 'ProfileImage']
      : ['Banner', 'banner', 'Cover', 'cover', 'coverImage', 'CoverImage'];
  const raw = pickProfileField(profile, keys);
  if (!raw) return null;
  if (raw.startsWith('data:') || ARWEAVE_TX_ID_RE.test(raw)) return raw;
  if (raw.startsWith('ar://')) return raw.slice(5);
  const fromUrl = raw.match(/\/([A-Za-z0-9_-]{43})(?:$|[?#/])/);
  if (fromUrl?.[1]) return fromUrl[1];
  return raw;
}

export function isPermawebMediaInput(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  return ARWEAVE_TX_ID_RE.test(v) || v.startsWith('data:');
}

/** Keep local identity when HB reads lag behind a successful zone write. */
export function mergeProfileIdentity(preferred: any, fetched: any): any {
  if (!preferred?.id) return fetched || preferred;
  if (!fetched?.id) return preferred;
  const merged = { ...fetched, ...preferred, id: preferred.id };
  const keys = [
    'username',
    'Username',
    'handle',
    'Handle',
    'displayName',
    'DisplayName',
    'name',
    'Name',
    'description',
    'Description',
    'bio',
    'Bio',
    'thumbnail',
    'Thumbnail',
    'banner',
    'Banner',
    'audiusHandle',
    'AudiusHandle',
  ];
  for (const key of keys) {
    if (!(key in preferred)) continue;
    const value = preferred[key];
    if (value === 'None') continue;
    if (typeof value === 'string') merged[key] = value;
  }
  if (preferred.__writtenAt) merged.__writtenAt = preferred.__writtenAt;
  return merged;
}

export function markProfileWrite(profile: any) {
  return { ...profile, __writtenAt: Date.now() };
}

export function shouldPreferLocalProfileWrite(local: any, maxAgeMs = 90_000): boolean {
  const writtenAt = Number(local?.__writtenAt || 0);
  return writtenAt > 0 && Date.now() - writtenAt < maxAgeMs;
}

/** Wander permissions for HyperBEAM ans104 (SIGN_TRANSACTION) + httpsig (SIGNATURE) writes. */
export async function connectArweaveSignerForProfile(signerWallet: any) {
  if (!signerWallet?.connect) return;
  await signerWallet.connect([
    'ACCESS_ADDRESS',
    'ACCESS_PUBLIC_KEY',
    'SIGN_TRANSACTION',
    'SIGNATURE',
    'DISPATCH',
  ]);
}

export function resolveArweaveSigner(_arweaveApi: any) {
  const injectedWallet = typeof window !== 'undefined' ? (window as any).arweaveWallet : null;
  if (!injectedWallet) {
    throw new Error(
      'Wander wallet extension is required to save profile changes. Open Wander, connect, and retry.'
    );
  }
  return injectedWallet;
}

function isRetryableProfileWriteError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message || error || '');
  if (/timed out|timeout/i.test(msg)) return false;
  return /HTTP request failed|request failed|failed to fetch|connection closed|Error sending message/i.test(
    msg
  );
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function readProfileTextField(profile: any, keys: string[]): string {
  for (const key of keys) {
    const value = profile?.[key];
    if (typeof value === 'string' && value.trim() && value.trim() !== 'None') {
      return value.trim();
    }
  }
  return '';
}

function normalizeProfileMediaRef(value: string | null | undefined): string {
  if (!value || value === 'None') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('ar://')) return trimmed.slice(5);
  const fromUrl = trimmed.match(/\/([A-Za-z0-9_-]{43})(?:$|[?#/])/);
  if (fromUrl?.[1]) return fromUrl[1];
  return trimmed;
}

function profileFieldMatchSnapshot(profile: any, expected: PermawebProfileArgs) {
  const username = readProfileTextField(profile, ['username', 'Username', 'handle', 'Handle']);
  const displayName = readProfileTextField(profile, ['displayName', 'DisplayName', 'name', 'Name']);
  const description = readProfileTextField(profile, ['description', 'Description', 'bio', 'Bio']);
  const thumbnailMatches =
    expected.thumbnail === undefined ||
    normalizeProfileMediaRef(extractRawProfileMediaRef(profile, 'thumbnail')) ===
      normalizeProfileMediaRef(expected.thumbnail);
  const bannerMatches =
    expected.banner === undefined ||
    normalizeProfileMediaRef(extractRawProfileMediaRef(profile, 'banner')) ===
      normalizeProfileMediaRef(expected.banner);
  return {
    username,
    displayName,
    description,
    thumbnailMatches,
    bannerMatches,
    matches:
      username === expected.username.trim() &&
      displayName === expected.displayName.trim() &&
      description === expected.description.trim() &&
      thumbnailMatches &&
      bannerMatches,
  };
}

/** Poll HyperBEAM until the zone store shows the expected profile fields. */
export async function confirmProfileWriteOnChain(args: {
  readLibs: any;
  profileId: string;
  expected: PermawebProfileArgs;
  timeoutMs?: number;
  onStatus?: (message: string) => void;
}): Promise<any> {
  const deadline = Date.now() + (args.timeoutMs ?? PROFILE_CHAIN_CONFIRM_TIMEOUT_MS);
  clearProfileReadBackoff(args.profileId);

  let confirmPolls = 0;
  while (Date.now() < deadline) {
    confirmPolls += 1;
    args.onStatus?.('Waiting for Portal HyperBEAM to confirm your profile on-chain…');
    try {
      const fresh = await getProfileByIdSafe(args.readLibs, args.profileId, { timeoutMs: 20_000 });
      const snapshot = fresh?.id ? profileFieldMatchSnapshot(fresh, args.expected) : null;
      const matches = Boolean(snapshot?.matches);
      if (fresh?.id && matches) {
        profileLog('confirmProfileWriteOnChain ok', { profileId: args.profileId });
        return fresh;
      }
    } catch (error) {
    }
    await sleep(PROFILE_CHAIN_CONFIRM_POLL_MS);
  }

  throw new Error(
    'Profile update is not visible on Portal HyperBEAM yet. Wait a minute, refresh, and retry if your changes still do not appear.'
  );
}

/**
 * Push zone update, then poll until Portal HB reflects the change.
 * On ambiguous push errors (timeout / connection closed), still polls — no local-only fallback.
 */
export async function writeAndConfirmProfileUpdate(args: {
  writableLibs: any;
  readLibs: any;
  profileArgs: PermawebProfileArgs;
  profileId: string;
  form?: ProfileEditForm;
  onStatus?: (status: unknown) => void;
  getWritableLibs?: (options?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    mode?: 'mainnet' | 'legacy';
  }) => Promise<any>;
  writeOptions?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    writeNodeUrls?: string[];
  };
}): Promise<any> {
  try {
    await writePermawebProfileUpdate(
      args.writableLibs,
      args.profileArgs,
      args.profileId,
      args.onStatus,
      undefined,
      args.form,
      args.getWritableLibs,
      args.writeOptions
    );
  } catch (error) {
    if (!isLikelyPortalPushDelay(error)) throw error;
    profileLog('push response ambiguous — polling chain for confirmation', error);
    args.onStatus?.('Push response unclear — checking Portal HyperBEAM for your update…');
  }

  return confirmProfileWriteOnChain({
    readLibs: args.readLibs,
    profileId: args.profileId,
    expected: args.profileArgs,
    onStatus: (message) => args.onStatus?.(message),
  });
}

/** Portal HB often drops the push response after accepting the message (ERR_CONNECTION_CLOSED 200). */
function isLikelyPortalPushDelay(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message || error || '');
  if (/Profile media upload timed out/i.test(msg)) return false;
  return /Profile update timed out|Profile update: Portal|did not respond in time|connection closed|HTTP request failed|Error sending message/i.test(
    msg
  );
}

function normalizeProfileWriteError(error: unknown, label: string): Error {
  const msg = String((error as { message?: string })?.message || error || label);
  if (/HTTP request failed|Error sending message|connection closed/i.test(msg)) {
    return new Error(
      `${label}: Portal HyperBEAM did not accept the update (connection closed). Unlock Wander, approve signing, and retry.`
    );
  }
  return error instanceof Error ? error : new Error(msg);
}

async function withHbWriteRetries<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableProfileWriteError(error) || attempt >= maxAttempts - 1) break;
      const delay = 1000 * Math.pow(2, attempt);
      profileLog(`${label} retry`, { attempt: attempt + 2, delay, error: String((error as any)?.message || error) });
      await new Promise<void>((resolve) => window.setTimeout(resolve, delay));
    }
  }
  throw normalizeProfileWriteError(lastError, label);
}

function withWriteTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(
        new Error(
          `${label} timed out. Unlock Wander, approve SIGN_TRANSACTION + DISPATCH, then retry.`
        )
      );
    }, timeoutMs);
    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error: any) => {
        window.clearTimeout(timer);
        const msg = String(error?.message || error || '');
        if (error?.name === 'AbortError' || msg.includes('aborted')) {
          reject(
            new Error(
              `${label} failed: Portal HyperBEAM did not respond in time. Retry in a moment — Wander should prompt during signing.`
            )
          );
          return;
        }
        reject(error);
      });
  });
}

/** Zone store payload matching permaweb-libs updateProfile (Username, DisplayName, etc.). */
export function profileArgsToZoneObject(args: PermawebProfileArgs): Record<string, string> {
  return {
    Username: args.username,
    DisplayName: args.displayName,
    Description: args.description,
    Thumbnail: args.thumbnail || 'None',
    Banner: args.banner || 'None',
  };
}

function isPushAttemptFailure(error: unknown): boolean {
  return isLikelyPortalPushDelay(error);
}

/** ao-core uses global fetch — scope resilient push (async-first) during zone writes only. */
export async function withProfileAoWrite<T>(
  fn: () => Promise<T>,
  options?: { writeNodeUrls?: string[]; pushAttemptTimeoutMs?: number; retries?: number }
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createResilientAoFetch({
    pushAttemptTimeoutMs: options?.pushAttemptTimeoutMs ?? 15_000,
    retries: options?.retries ?? 2,
    writeNodeUrls: options?.writeNodeUrls,
    fetchImpl: originalFetch,
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function pushProfileZoneUpdateWithLibs(
  writableLibs: any,
  args: PermawebProfileArgs,
  profileId: string,
  form: ProfileEditForm | undefined,
  timeoutMs: number,
  label: string
): Promise<void> {
  const zone = profileArgsToZoneObject(args);
  if (form?.removeThumbnail) zone.Thumbnail = 'None';
  if (form?.removeBanner) zone.Banner = 'None';

  profileLog(`${label} → updateZone`, { profileId, zone });

  if (!writableLibs?.updateZone) {
    throw new Error('Writable permaweb client unavailable. Reconnect Wander and retry.');
  }


  try {
    await withHbWriteRetries(
      () =>
        withWriteTimeout(
          writableLibs.updateZone(zone, profileId),
          timeoutMs,
          label
        ),
      label
    );
  } catch (error) {
    throw error;
  }
}

async function pushProfileZoneUpdate(
  writableLibs: any,
  args: PermawebProfileArgs,
  profileId: string,
  form?: ProfileEditForm,
  getWritableLibs?: (options?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    mode?: 'mainnet' | 'legacy';
  }) => Promise<any>,
  writeOptions?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    writeNodeUrls?: string[];
  },
  onStatus?: (status: unknown) => void
): Promise<void> {
  const nodeUrls =
    writeOptions?.writeNodeUrls?.filter(Boolean) ||
    (writeOptions?.url ? [writeOptions.url] : resolveProfileZoneWriteNodeUrls());

  if (!getWritableLibs || nodeUrls.length === 0) {
    await withProfileAoWrite(
      () =>
        pushProfileZoneUpdateWithLibs(
          writableLibs,
          args,
          profileId,
          form,
          PROFILE_PUSH_ATTEMPT_TIMEOUT_MS,
          'Profile update'
        ),
      { writeNodeUrls: nodeUrls.length ? nodeUrls : undefined }
    );
    return;
  }

  let lastError: unknown;
  for (let index = 0; index < nodeUrls.length; index++) {
    const nodeUrl = nodeUrls[index];
    const shortHost = nodeUrl.replace(/^https?:\/\//, '').split('/')[0];
    const label =
      index === 0 ? 'Profile update' : `Profile update (${shortHost})`;
    if (index > 0) {
      onStatus?.(`Retrying profile push via ${shortHost}…`);
    }

    try {
      const libs =
        index === 0 && normalizeProfileWriteNodeUrl(writableLibs?.node?.url) === nodeUrl
          ? writableLibs
          : await getWritableProfileLibs(getWritableLibs, {
              ...(writeOptions || {}),
              url: nodeUrl,
            });
      await withProfileAoWrite(
        () =>
          pushProfileZoneUpdateWithLibs(
            libs,
            args,
            profileId,
            form,
            index === 0 ? PROFILE_PUSH_ATTEMPT_TIMEOUT_MS : PROFILE_PUSH_TIMEOUT_MS,
            label
          ),
        { writeNodeUrls: nodeUrls }
      );
      return;
    } catch (error) {
      lastError = error;
      if (!isPushAttemptFailure(error) && index >= nodeUrls.length - 1) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Profile update failed on all HyperBEAM write nodes. Retry in a moment.');
}

function normalizeProfileWriteNodeUrl(url: string | null | undefined): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

/**
 * Push Zone-Update to Portal HB. Media must already be resolved tx ids in `args`.
 */
export async function writePermawebProfileUpdate(
  writableLibs: any,
  args: PermawebProfileArgs,
  profileId: string,
  onStatus?: (status: unknown) => void,
  _existingProfile?: any,
  form?: ProfileEditForm,
  getWritableLibs?: (options?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    mode?: 'mainnet' | 'legacy';
  }) => Promise<any>,
  writeOptions?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    writeNodeUrls?: string[];
  }
): Promise<void> {
  if (!writableLibs?.updateZone && !writableLibs?.updateProfile) {
    throw new Error('Writable permaweb client unavailable. Reconnect Wander and retry.');
  }

  onStatus?.('Saving profile…');
  profileLog('writePermawebProfileUpdate', {
    profileId,
    zone: profileArgsToZoneObject(args),
  });
  await pushProfileZoneUpdate(
    writableLibs,
    args,
    profileId,
    form,
    getWritableLibs,
    writeOptions,
    onStatus
  );
}

export async function buildPermawebProfileArgsWithTimeout(
  form: ProfileEditForm,
  fileToDataURL: (file: File) => Promise<string>,
  writableLibs?: any,
  existingProfile?: any
): Promise<PermawebProfileArgs> {
  try {
    const args = await withWriteTimeout(
      buildPermawebProfileArgs(form, fileToDataURL, writableLibs, existingProfile),
      PROFILE_MEDIA_TIMEOUT_MS,
      'Profile media upload'
    );
    return args;
  } catch (error) {
    throw error;
  }
}

export async function getWritableProfileLibs(
  getWritableLibs: (options?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    mode?: 'mainnet' | 'legacy';
  }) => Promise<any>,
  options?: { url?: string; scheduler?: string; authority?: string; mode?: 'mainnet' | 'legacy' }
): Promise<any> {
  const libs = await getWritableLibs(options);
  if (!libs?.updateZone && !libs?.updateProfile && !libs?.createProfile) {
    throw new Error('Writable permaweb client unavailable. Reconnect Wander and retry.');
  }
  return libs;
}

/**
 * Spawn a new profile zone with HyperBEAM node fallback (Portal → Bazar HB).
 * ao-core spawn POSTs to `{node}/push`, not `~process@1.0/push`.
 */
export async function createPermawebProfile(args: {
  writableLibs: any;
  profileArgs: PermawebProfileArgs;
  getWritableLibs?: (options?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    mode?: 'mainnet' | 'legacy';
  }) => Promise<any>;
  writeOptions?: {
    url?: string;
    scheduler?: string;
    authority?: string;
    writeNodeUrls?: string[];
  };
  onStatus?: (status: unknown) => void;
}): Promise<string> {
  const nodeUrls =
    args.writeOptions?.writeNodeUrls?.filter(Boolean) ||
    (args.writeOptions?.url ? [args.writeOptions.url] : resolveProfileZoneWriteNodeUrls());

  if (!args.getWritableLibs || nodeUrls.length === 0) {
    const profileId = await withProfileAoWrite<string>(
      () => args.writableLibs.createProfile(args.profileArgs, args.onStatus),
      { writeNodeUrls: nodeUrls.length ? nodeUrls : undefined, pushAttemptTimeoutMs: PROFILE_PUSH_ATTEMPT_TIMEOUT_MS }
    );
    if (!profileId) throw new Error('permaweb-libs createProfile returned no profile id.');
    return profileId;
  }

  let lastError: unknown;
  for (let index = 0; index < nodeUrls.length; index++) {
    const nodeUrl = nodeUrls[index];
    const shortHost = nodeUrl.replace(/^https?:\/\//, '').split('/')[0];
    if (index > 0) {
      args.onStatus?.(`Retrying profile creation via ${shortHost}…`);
    }

    try {
      const libs =
        index === 0 && normalizeProfileWriteNodeUrl(args.writableLibs?.node?.url) === nodeUrl
          ? args.writableLibs
          : await getWritableProfileLibs(args.getWritableLibs, {
              ...(args.writeOptions || {}),
              url: nodeUrl,
            });
      const profileId = await withProfileAoWrite<string>(
        () => libs.createProfile(args.profileArgs, args.onStatus),
        { writeNodeUrls: nodeUrls, pushAttemptTimeoutMs: PROFILE_PUSH_ATTEMPT_TIMEOUT_MS }
      );
      if (!profileId) throw new Error('permaweb-libs createProfile returned no profile id.');
      return profileId;
    } catch (error) {
      lastError = error;
      if (!isPushAttemptFailure(error) && index >= nodeUrls.length - 1) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Profile creation failed on all HyperBEAM write nodes. Retry in a moment.');
}

/**
 * Build args for permaweb-libs `createProfile` / `updateProfile`.
 * SDK maps these to zone store keys: Username, DisplayName, Description, Thumbnail, Banner.
 * Omitting thumbnail/banner on update sets them to "None" in the SDK — pass existing tx ids when unchanged.
 */
export async function buildPermawebProfileArgs(
  form: ProfileEditForm,
  fileToDataURL: (file: File) => Promise<string>,
  writableLibs?: any,
  existingProfile?: any
): Promise<PermawebProfileArgs> {
  const args: PermawebProfileArgs = {
    username: form.username.trim(),
    displayName: form.displayName.trim(),
    description: form.description.trim(),
  };

  const resolveMedia = async (value: string | null | undefined) => {
    if (!value) return null;
    const trimmed = value.trim();
    if (ARWEAVE_TX_ID_RE.test(trimmed)) return trimmed;
    if (!trimmed.startsWith('data:')) return null;
    if (!writableLibs) return trimmed;
    return (await resolveProfileZoneMediaId(writableLibs, trimmed)) || trimmed;
  };

  if (!form.removeThumbnail) {
    if (form.thumbnail) {
      const dataUrl = await fileToDataURL(form.thumbnail);
      const resolved = await resolveMedia(dataUrl);
      if (resolved) args.thumbnail = resolved;
    } else {
      const keep =
        form.thumbnailValue || (existingProfile ? extractRawProfileMediaRef(existingProfile, 'thumbnail') : null);
      const resolved = await resolveMedia(keep);
      if (resolved) args.thumbnail = resolved;
    }
  }

  if (!form.removeBanner) {
    if (form.banner) {
      const dataUrl = await fileToDataURL(form.banner);
      const resolved = await resolveMedia(dataUrl);
      if (resolved) args.banner = resolved;
    } else {
      const keep =
        form.bannerValue || (existingProfile ? extractRawProfileMediaRef(existingProfile, 'banner') : null);
      const resolved = await resolveMedia(keep);
      if (resolved) args.banner = resolved;
    }
  }

  return args;
}

/** Optional zone fields not covered by ProfileArgsType (Audius link, proof). */
export async function applyProfileZoneExtras(
  writableLibs: any,
  profileId: string,
  extras: { audiusHandle?: string; audiusProof?: string },
  _existingProfile?: any
) {
  const patch: Record<string, string> = {};
  if (extras.audiusHandle?.trim()) patch.AudiusHandle = extras.audiusHandle.trim();
  if (extras.audiusProof) patch.AudiusProof = extras.audiusProof;
  if (Object.keys(patch).length === 0) return;
  if (!writableLibs?.updateZone) {
    throw new Error('Writable permaweb client unavailable. Reconnect Wander and retry.');
  }
  profileLog('applyProfileZoneExtras → updateZone', { profileId, keys: Object.keys(patch) });
  await withProfileAoWrite(() =>
    withHbWriteRetries(
      () => writableLibs.updateZone(patch, profileId),
      'Profile zone extras'
    )
  );
}

export function buildOptimisticProfileState(
  base: any,
  profileId: string,
  args: PermawebProfileArgs,
  form: ProfileEditForm
) {
  const optimistic = {
    ...(base || {}),
    id: profileId,
    username: args.username,
    Username: args.username,
    handle: args.username,
    Handle: args.username,
    displayName: args.displayName,
    DisplayName: args.displayName,
    name: args.displayName,
    Name: args.displayName,
    description: args.description,
    Description: args.description,
    bio: args.description,
    Bio: args.description,
    ...(form.removeThumbnail ? { thumbnail: null, Thumbnail: null } : {}),
    ...(form.removeBanner ? { banner: null, Banner: null } : {}),
    ...(args.thumbnail ? { thumbnail: args.thumbnail, Thumbnail: args.thumbnail } : {}),
    ...(args.banner ? { banner: args.banner, Banner: args.banner } : {}),
    ...(form.audiusHandle?.trim() ? { audiusHandle: form.audiusHandle.trim() } : {}),
  };
  return markProfileWrite(optimistic);
}

export async function refreshProfileAfterWrite(args: {
  readLibs: any;
  profileId: string;
  connectedAddress: string;
  optimistic: any;
  timeoutMs?: number;
}) {
  clearProfileReadBackoff(args.profileId);
  invalidateLatestProfileCache(args.connectedAddress);
  try {
    const fresh = await getProfileByIdSafe(args.readLibs, args.profileId, {
      timeoutMs: args.timeoutMs ?? 5000,
    });
    if (!fresh?.id) return args.optimistic;
    return fresh;
  } catch {
    return args.optimistic;
  }
}
