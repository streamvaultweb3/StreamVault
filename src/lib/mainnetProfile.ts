type ProfileCreateArgs = {
  username: string;
  displayName: string;
  description: string;
  audiusHandle?: string;
  thumbnail?: string | null;
  banner?: string | null;
};

import {
  MAINNET_AO_URL,
  MAINNET_ZONE_SOURCE,
  runMainnetSpawnDiagnostic,
  spawnProcessDirect,
} from './aoSpawnDiagnostic';

async function sleep(ms: number) {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForProcessReady(processId: string, attempts = 8) {
  const base = MAINNET_AO_URL.replace(/\/+$/, '');
  let lastStatus = 0;

  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(500 * (i + 1));
    try {
      const res = await fetch(`${base}/${processId}~process@1.0/now`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      lastStatus = res.status;
      if (res.ok) return;
    } catch {
      // keep retrying
    }
  }

  console.info('[ao:profile] process not yet readable before update', { processId, lastStatus });
}

async function resolveMediaId(libs: any, value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  if (typeof libs?.resolveTransaction !== 'function') return null;
  try {
    return await libs.resolveTransaction(value);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.info('[ao:profile] media resolve failed', {
        error: String((error as any)?.message || error),
      });
    }
    return null;
  }
}

export async function createMainnetProfile(
  libs: any,
  args: ProfileCreateArgs
): Promise<{ profileId: string; thumbnailId: string | null; bannerId: string | null }> {
  if (!libs) {
    throw new Error('Writable permaweb mainnet client is not ready.');
  }

  const [thumbnailId, bannerId] = await Promise.all([
    resolveMediaId(libs, args.thumbnail),
    resolveMediaId(libs, args.banner),
  ]);

  if (import.meta.env.DEV) {
    console.info('[ao:profile] resolved media ids', {
      hasThumbnailInput: Boolean(args.thumbnail),
      hasBannerInput: Boolean(args.banner),
      thumbnailId,
      bannerId,
    });
  }

  try {
    const tags = [
      { name: 'On-Boot', value: MAINNET_ZONE_SOURCE },
      { name: 'Data-Protocol', value: 'ao' },
      { name: 'Zone-Type', value: 'User' },
      { name: 'Bootloader-Username', value: args.username },
      { name: 'Bootloader-DisplayName', value: args.displayName },
      { name: 'Bootloader-Description', value: args.description },
      ...(thumbnailId ? [{ name: 'Bootloader-Thumbnail', value: thumbnailId }] : []),
      ...(bannerId ? [{ name: 'Bootloader-Banner', value: bannerId }] : []),
    ];

    const { processId: profileId } = await spawnProcessDirect({
      tags,
    });

    if (!profileId) {
      throw new Error('permaweb-libs createProfile returned no profile id.');
    }

    if (import.meta.env.DEV) {
      console.info('[ao:profile] spawn tags', {
        profileId,
        thumbnailId,
        bannerId,
        includesThumbnailTag: Boolean(thumbnailId),
        includesBannerTag: Boolean(bannerId),
      });
    }

    if (import.meta.env.DEV && args.audiusHandle) {
      await waitForProcessReady(profileId);
      console.info('[ao:profile] deferred Audius handle link until after profile creation', {
        profileId,
        audiusHandle: args.audiusHandle,
      });
    }

    return {
      profileId,
      thumbnailId,
      bannerId,
    };
  } catch (error: any) {
    if (import.meta.env.DEV) {
      const diag = await runMainnetSpawnDiagnostic(libs).catch((diagError) => ({
        diagnosticError: String((diagError as any)?.message || diagError),
      }));
      console.info('[ao:spawn:diag]', diag);
    }
    throw error;
  }
}
