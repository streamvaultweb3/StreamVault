import { connect, createDataItemSigner } from '@permaweb/aoconnect';

/** Matches `@permaweb/aoconnect` mainnet `DEFAULT_HB_URL` (avoid `push.forward`, which can overload the browser). */
export const MAINNET_AO_URL = 'https://tee-6.forward.computer';
export const MAINNET_AO_MODULE = 'ISShJH1ij-hPPt9St5UFFr_8Ys3Kj5cyg7zrMGt7H9s';
export const MAINNET_AO_SCHEDULER = 'n_XZJhUnmldNFo4dhajoPZWhBXuJk-OcQr5JQ49c4Zo';
export const MAINNET_ZONE_SOURCE = 'd4iFzJ4gxQRPHLuF13C7ncHgd-_yGGV8MtZSZmgLn7Y';
export const MAINNET_AO_AUTHORITY = 'fcoN_xJeisVsPXA-trzVAuIiqO3ydLQxM-L4XbrQKzY';

type TraceEntry = {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  requestBody?: string | null;
  responseBody?: string | null;
};

type SpawnProcessArgs = {
  module?: string;
  scheduler?: string;
  data?: string;
  tags?: Array<{ name: string; value: string }>;
  skipInit?: boolean;
};

function getInjectedWallet(): any | null {
  if (typeof window === 'undefined') return null;
  return (window as any).arweaveWallet || null;
}

function sanitizeTags(tags: Array<{ name: string; value: string }>) {
  return tags.map((tag) => ({
    ...tag,
    value: tag.value?.replace(/\r?\n/g, ' ') ?? '',
  }));
}

function getTagValue(tags: Array<{ name: string; value: string }>, name: string): string | null {
  const tag = tags.find((entry) => entry.name === name);
  return tag?.value || null;
}

function withRequiredAoTags(tags: Array<{ name: string; value: string }>) {
  const next = [...tags];
  const hasDataProtocol = next.some((tag) => tag.name === 'Data-Protocol');
  const hasAuthority = next.some((tag) => tag.name === 'Authority');
  if (!hasDataProtocol) {
    next.unshift({ name: 'Data-Protocol', value: 'ao' });
  }
  if (!hasAuthority) {
    next.unshift({ name: 'Authority', value: MAINNET_AO_AUTHORITY });
  }
  return next;
}

function buildLoggedFetch(trace: TraceEntry[]) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || 'GET';
    let requestBody: string | null = null;
    if (typeof init?.body === 'string') requestBody = init.body;
    const res = await fetch(input, init);
    const clone = res.clone();
    let responseBody: string | null = null;
    try {
      responseBody = await clone.text();
    } catch {
      responseBody = null;
    }
    trace.push({
      url,
      method,
      status: res.status,
      ok: res.ok,
      requestBody,
      responseBody,
    });
    return res;
  };
}

function createMainnetAo(trace: TraceEntry[]) {
  const wallet = getInjectedWallet();
  if (!wallet) throw new Error('Arweave wallet is not available in the browser.');
  const signer = createDataItemSigner(wallet);
  const ao = connect({
    MODE: 'mainnet',
    URL: MAINNET_AO_URL,
    SCHEDULER: MAINNET_AO_SCHEDULER,
    signer,
    fetch: buildLoggedFetch(trace),
  } as any);
  return { ao, signer };
}

export async function spawnProcessDirect(args: SpawnProcessArgs) {
  const trace: TraceEntry[] = [];
  const { ao, signer } = createMainnetAo(trace);
  const rawTags = sanitizeTags([
    { name: 'Process-Timestamp', value: Date.now().toString() },
    ...(args.tags || []),
  ]);
  const onBoot = getTagValue(rawTags, 'On-Boot');
  const spawnTags = withRequiredAoTags(
    onBoot ? rawTags.filter((tag) => tag.name !== 'On-Boot') : rawTags
  );

  const processId = await ao.spawn({
    module: args.module || MAINNET_AO_MODULE,
    scheduler: args.scheduler || MAINNET_AO_SCHEDULER,
    signer,
    tags: spawnTags,
    data: args.data,
  });

  if (onBoot) {
    const source = await fetch(`https://arweave.net/${onBoot}`).then((res) => {
      if (!res.ok) throw new Error(`Failed to fetch On-Boot source: HTTP ${res.status}`);
      return res.text();
    });
    await ao.message({
      process: processId,
      signer,
      tags: [
        { name: 'Action', value: 'Eval' },
        { name: 'Message-Timestamp', value: Date.now().toString() },
      ],
      data: source,
    });
  }

  if (!args.skipInit) {
    await ao.message({
      process: processId,
      signer,
      tags: [
        { name: 'Action', value: 'Init' },
        { name: 'Message-Timestamp', value: Date.now().toString() },
      ],
    });
  }

  return { processId, trace };
}

export async function runMainnetSpawnDiagnostic(libs?: any) {
  const trace: TraceEntry[] = [];
  const result: any = { direct: null, wrapped: null, trace };

  try {
    const direct = await spawnProcessDirect({
      tags: [],
    });
    result.direct = { ok: true, processId: direct.processId, trace: direct.trace };
  } catch (error: any) {
    result.direct = { ok: false, error: String(error?.message || error), trace: [...trace] };
  }

  if (libs?.createProcess) {
    try {
      const wrappedId = await libs.createProcess({
        module: MAINNET_AO_MODULE,
        scheduler: MAINNET_AO_SCHEDULER,
        tags: [],
      });
      result.wrapped = { ok: true, processId: wrappedId };
    } catch (error: any) {
      result.wrapped = { ok: false, error: String(error?.message || error) };
    }
  }

  return result;
}
