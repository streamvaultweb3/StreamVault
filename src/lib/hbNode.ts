import { resolveHbReadNodeUrls } from './aoNode';
import {
  resolveHbReadNodeUrlsForProcess,
  resolvePreferredNodesForProcess,
} from './hbScheduler';

/** Per-node HB GET/POST cap — fail fast to next node (Portal is often slow). */
export const HB_REQUEST_TIMEOUT_MS = 8_000;

/**
 * After a *rich* non-owner response, briefly wait for the scheduler-matching node
 * before accepting the fast peer (covers Portal-owned assets answered early by Bazar).
 */
export const HB_OWNER_PREFER_GRACE_MS = 3_000;

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

function normalizeNodeBase(url: string): string {
  return String(url || '').replace(/\/+$/, '');
}

/** True when Balances looks like real holdings (not empty [] / {}). */
export function hyperbeamBalancesHaveHoldings(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const body = json as Record<string, unknown>;
  const bal = body.Balances ?? body.balances;
  if (!bal || typeof bal !== 'object') return false;
  if (Array.isArray(bal)) {
    return bal.some((row) => {
      if (!row || typeof row !== 'object') return false;
      const qty = Number((row as Record<string, unknown>).Balance ?? (row as Record<string, unknown>).balance ?? 0);
      return Number.isFinite(qty) && qty > 0;
    });
  }
  return Object.values(bal as Record<string, unknown>).some((v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0;
  });
}

/**
 * Race HB peers, but do not let a fast empty Bazar answer beat the scheduler-matching
 * owner node (Portal / operator) while that owner read is still in flight.
 */
async function raceHbNodes(args: {
  processId: string;
  subpath: string;
  label?: string;
  validate: (json: unknown) => boolean;
  nodes: string[];
  /** Scheduler-matching node bases — preferred over faster empty peers. */
  preferredNodeUrls?: string[];
}): Promise<HyperbeamReadResult | null> {
  if (args.nodes.length === 0) return null;

  const preferred = new Set(
    (args.preferredNodeUrls || []).map(normalizeNodeBase).filter(Boolean)
  );
  const nodes = args.nodes.map(normalizeNodeBase).filter(Boolean);
  const preferredInFlight = new Set(nodes.filter((n) => preferred.has(n)));

  // No owner match → classic first-valid wins (Bazar-first latency behavior).
  if (preferredInFlight.size === 0) {
    return new Promise((resolve) => {
      let remaining = nodes.length;
      let settled = false;
      for (const base of nodes) {
        const url = `${base}/${args.processId}~process@1.0/${args.subpath}`;
        void hbRequest({
          label: args.label || `hb-read:${args.subpath}`,
          url,
          method: 'GET',
          headers: HB_READ_HEADERS,
        })
          .then((res) => {
            if (settled) return;
            if (!res.json || isHyperbeamReadFailure(res.json, res.text)) return;
            if (!args.validate(res.json)) return;
            settled = true;
            resolve({ json: res.json as Record<string, unknown>, nodeUrl: base, url });
          })
          .catch(() => {})
          .finally(() => {
            remaining -= 1;
            if (!settled && remaining <= 0) resolve(null);
          });
      }
    });
  }

  return new Promise((resolve) => {
    let remaining = nodes.length;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let richFallback: HyperbeamReadResult | null = null;
    let weakFallback: HyperbeamReadResult | null = null;

    const finish = (result: HyperbeamReadResult | null) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };

    const takeBestFallback = () => richFallback || weakFallback;

    const markPreferredDone = (base: string) => {
      if (preferredInFlight.has(base)) preferredInFlight.delete(base);
    };

    for (const base of nodes) {
      const url = `${base}/${args.processId}~process@1.0/${args.subpath}`;
      const isPreferred = preferred.has(base);
      void hbRequest({
        label: args.label || `hb-read:${args.subpath}`,
        url,
        method: 'GET',
        headers: HB_READ_HEADERS,
      })
        .then((res) => {
          if (settled) return;
          if (!res.json || isHyperbeamReadFailure(res.json, res.text)) return;
          if (!args.validate(res.json)) return;
          const result: HyperbeamReadResult = {
            json: res.json as Record<string, unknown>,
            nodeUrl: base,
            url,
          };

          if (isPreferred) {
            // Owner-node truth wins immediately (even empty Balances).
            finish(result);
            return;
          }

          const rich = hyperbeamBalancesHaveHoldings(result.json);
          if (rich) {
            if (
              !richFallback ||
              !hyperbeamBalancesHaveHoldings(richFallback.json)
            ) {
              richFallback = result;
            }
            // Still give the owner node a short window before accepting a rich peer.
            if (preferredInFlight.size > 0 && !graceTimer) {
              graceTimer = setTimeout(() => {
                finish(takeBestFallback());
              }, HB_OWNER_PREFER_GRACE_MS);
            } else if (preferredInFlight.size === 0) {
              finish(result);
            }
            return;
          }

          // Empty Balances from non-owner: hold weakly; never beat an in-flight owner.
          if (!weakFallback) weakFallback = result;
          if (preferredInFlight.size === 0) finish(takeBestFallback());
        })
        .catch(() => {})
        .finally(() => {
          remaining -= 1;
          if (isPreferred) markPreferredDone(base);
          if (settled) return;
          if (preferredInFlight.size === 0) {
            finish(takeBestFallback());
            return;
          }
          if (remaining <= 0) finish(takeBestFallback());
        });
    }
  });
}

/**
 * Read process JSON from HyperBEAM.
 * Scheduler-matching nodes (Portal / operator) win over faster empty Bazar answers.
 */
export async function fetchHyperbeamJson(args: {
  processId: string;
  subpath?: string;
  label?: string;
  validate?: (json: unknown) => boolean;
  /** Skip spawn-tag lookup (use default read order). */
  skipSchedulerPrefer?: boolean;
}): Promise<HyperbeamReadResult | null> {
  const subpath = args.subpath || 'compute/asset';
  const validate = args.validate || (() => true);
  const nodes = args.skipSchedulerPrefer
    ? resolveHbReadNodeUrls()
    : await resolveHbReadNodeUrlsForProcess(args.processId);
  const preferredNodeUrls = args.skipSchedulerPrefer
    ? []
    : (await resolvePreferredNodesForProcess(args.processId)).map((n) => n.url);
  return raceHbNodes({
    processId: args.processId,
    subpath,
    label: args.label,
    validate,
    nodes,
    preferredNodeUrls,
  });
}

export async function fetchHyperbeamAssetState(processId: string): Promise<HyperbeamReadResult | null> {
  return fetchHyperbeamJson({
    processId,
    subpath: 'compute/asset',
    label: 'hb-asset-state',
    validate: isHyperbeamAssetState,
  });
}

/** Metadata subpath — TotalSupply often lives here when top-level asset state uses +link fields. */
export async function fetchHyperbeamAssetMetadata(
  processId: string
): Promise<HyperbeamReadResult | null> {
  return fetchHyperbeamJson({
    processId,
    subpath: 'compute/asset/Metadata',
    label: 'hb-asset-metadata',
    validate: (json) => Boolean(json && typeof json === 'object'),
  });
}
