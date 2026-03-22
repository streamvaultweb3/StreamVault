import { connect, createDataItemSigner } from '@permaweb/aoconnect';

export const MAINNET_AO_URL = 'https://push.forward.computer';
export const MAINNET_AO_MODULE = 'ISShJH1ij-hPPt9St5UFFr_8Ys3Kj5cyg7zrMGt7H9s';
export const MAINNET_AO_SCHEDULER = '_GQ33BkPtZrqxA84vM8Zk-N2aO0toNNu_C-l-rawrBA';
export const MAINNET_ZONE_SOURCE = 'd4iFzJ4gxQRPHLuF13C7ncHgd-_yGGV8MtZSZmgLn7Y';

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

function withRequiredAoTags(tags: Array<{ name: string; value: string }>) {
  const next = [...tags];
  const hasDataProtocol = next.some((tag) => tag.name === 'Data-Protocol');
  if (!hasDataProtocol) {
    next.unshift({ name: 'Data-Protocol', value: 'ao' });
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
  const tags = withRequiredAoTags(sanitizeTags([
    { name: 'Process-Timestamp', value: Date.now().toString() },
    ...(args.tags || []),
  ]));

  const processId = await ao.spawn({
    module: args.module || MAINNET_AO_MODULE,
    scheduler: args.scheduler || MAINNET_AO_SCHEDULER,
    signer,
    tags,
    data: args.data,
  });

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
