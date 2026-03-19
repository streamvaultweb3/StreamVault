type ProfileOption = {
  id: string;
  timestamp?: number;
};

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

export async function getProfileOptionsByWallet(
  libs: any,
  walletAddress: string,
  gateway = 'ao-search-gateway.goldsky.com'
): Promise<ProfileOption[]> {
  if (!libs?.getGQLData || !walletAddress) return [];
  const [gqlA, gqlB] = await Promise.all([
    libs.getGQLData({
      tags: [
        { name: 'Data-Protocol', values: ['ao'] },
        { name: 'Zone-Type', values: ['User'] },
      ],
      owners: [walletAddress],
      gateway,
    }),
    libs.getGQLData({
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
  if (!libs || !walletAddress) return { id: null };
  const timeoutMs = opts?.timeoutMs ?? 6000;
  const gateway = opts?.gateway ?? 'ao-search-gateway.goldsky.com';

  // First query explicit profile index, then resolve newest profile id.
  const options = await getProfileOptionsByWallet(libs, walletAddress, gateway);
  if (options.length > 0 && libs.getProfileById) {
    try {
      for (const option of options.slice(0, 8)) {
        const candidate = await withTimeout<any>(
          libs.getProfileById(option.id),
          timeoutMs,
          'getProfileById'
        );
        if (!candidate?.id) continue;
        const hasIdentity =
          Boolean(getProfileDisplayName(candidate)) ||
          Boolean(getProfileHandle(candidate)) ||
          Boolean(getProfileBio(candidate)) ||
          Boolean(getProfileAvatar(candidate));
        if (hasIdentity) return candidate;
      }
      const latest = await withTimeout<any>(libs.getProfileById(options[0].id), timeoutMs, 'getProfileById');
      if (latest?.id) return latest;
    } catch {
      // Continue to SDK helper fallback.
    }
  }

  // Fallback to SDK helper.
  if (libs.getProfileByWalletAddress) {
    try {
      const sdkProfile: any = await withTimeout<any>(
        libs.getProfileByWalletAddress(walletAddress),
        timeoutMs,
        'getProfileByWalletAddress'
      );
      if (sdkProfile?.id) return sdkProfile;
    } catch {
      // Fallback below.
    }
  }
  return { id: null };
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
  if (selectedId && libs.getProfileById) {
    try {
      const selected = await withTimeout<any>(libs.getProfileById(selectedId), timeoutMs, 'getProfileById(selected)');
      if (selected?.id) return selected;
      clearStoredProfileOverrideId(walletAddress);
    } catch {
      clearStoredProfileOverrideId(walletAddress);
    }
  }
  return getLatestProfileByWallet(libs, walletAddress, opts);
}
