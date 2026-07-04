import { resolveHbReadNodeUrls } from './aoNode';

/** Per-node HB GET/POST cap — fail fast to next node (Portal is often slow). */
export const HB_REQUEST_TIMEOUT_MS = 8_000;

type HbRequestArgs = {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  label?: string;
  forceLog?: boolean;
  timeoutMs?: number;
};

/** Headers permaweb-libs uses for HyperBEAM JSON reads. */
export const HB_READ_HEADERS: Record<string, string> = {
  Accept: 'application/json',
  'accept-bundle': 'true',
  'require-codec': 'application/json',
};

export function isHyperbeamReadFailure(json: unknown, text: string): boolean {
  if (text.includes('necessary_message_not_found')) return true;
  if (text.includes('Error getting state from HyperBEAM')) return true;
  if (!json || typeof json !== 'object') return false;
  const body = json as Record<string, unknown>;
  if (body.body === 'not_found') return true;
  if (typeof body.details === 'string' && body.details.includes('necessary_message_not_found')) return true;
  if (typeof body.Error === 'string' && body.Error.includes('HyperBEAM')) return true;
  return false;
}

function isHyperbeamAssetState(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const body = json as Record<string, unknown>;
  return 'Name' in body || 'Metadata' in body || 'Creator' in body;
}

function shouldLog(force = false): boolean {
  if (force) return true;
  return import.meta.env.DEV && String(import.meta.env.VITE_DEBUG_HB || '') === '1';
}

function safeJsonParse(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function hbRequest(args: HbRequestArgs): Promise<{
  status: number;
  ok: boolean;
  contentType: string;
  json: any | null;
  text: string;
}> {
  const method = args.method || 'GET';
  const headers = args.headers || {};
  const body = args.body;
  const log = shouldLog(args.forceLog);

  if (log) {
    console.info('[hb:req]', {
      label: args.label || '',
      url: args.url,
      method,
      headers,
      body: body ?? null,
    });
  }

  const res = await fetch(args.url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(args.timeoutMs ?? HB_REQUEST_TIMEOUT_MS),
  });
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  const json = contentType.includes('application/json') ? safeJsonParse(text) : null;

  if (log) {
    console.info('[hb:res]', {
      label: args.label || '',
      url: args.url,
      method,
      status: res.status,
      contentType,
      body: json ?? text,
    });
  }

  return {
    status: res.status,
    ok: res.ok,
    contentType,
    json,
    text,
  };
}

export async function runHbNodeDiagnostics(pid: string, nodeBase: string) {
  const base = String(nodeBase || '').replace(/\/+$/, '');
  const headers = { Accept: 'application/json' };
  const results = [];

  results.push(await hbRequest({
    label: 'init',
    url: `${base}/${pid}~process@1.0/init`,
    method: 'GET',
    headers,
    forceLog: true,
  }));
  results.push(await hbRequest({
    label: 'slot/current',
    url: `${base}/${pid}~process@1.0/slot/current`,
    method: 'GET',
    headers,
    forceLog: true,
  }));
  results.push(await hbRequest({
    label: 'now',
    url: `${base}/${pid}~process@1.0/now`,
    method: 'GET',
    headers,
    forceLog: true,
  }));
  results.push(await hbRequest({
    label: 'Action=Info',
    url: `${base}/${pid}~process@1.0/as=execution/compute&Action=Info`,
    method: 'POST',
    headers: { Accept: 'application/json', 'accept-bundle': 'true' },
    forceLog: true,
  }));

  return results;
}

export type HyperbeamReadResult = {
  json: Record<string, unknown>;
  nodeUrl: string;
  url: string;
};

/** Try Portal HB first, then configured fallbacks (e.g. Bazar `app-1.forward.computer`). */
export async function fetchHyperbeamJson(args: {
  processId: string;
  subpath?: string;
  label?: string;
  validate?: (json: unknown) => boolean;
}): Promise<HyperbeamReadResult | null> {
  const subpath = args.subpath || 'compute/asset';
  const validate = args.validate || (() => true);
  for (const nodeBase of resolveHbReadNodeUrls()) {
    const base = nodeBase.replace(/\/+$/, '');
    const url = `${base}/${args.processId}~process@1.0/${subpath}`;
    try {
      const res = await hbRequest({
        label: args.label || `hb-read:${subpath}`,
        url,
        method: 'GET',
        headers: HB_READ_HEADERS,
      });
      if (!res.json || isHyperbeamReadFailure(res.json, res.text)) continue;
      if (!validate(res.json)) continue;
      return { json: res.json as Record<string, unknown>, nodeUrl: base, url };
    } catch {
      // try next node
    }
  }
  return null;
}

export async function fetchHyperbeamAssetState(processId: string): Promise<HyperbeamReadResult | null> {
  return fetchHyperbeamJson({
    processId,
    subpath: 'compute/asset',
    label: 'hb-asset-state',
    validate: isHyperbeamAssetState,
  });
}

