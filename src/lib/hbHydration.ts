import {
  AO_NODE,
  BAZAR_HB_NODE,
  LEGACY_AO_SCHEDULER,
  isOperatorHbUrl,
  resolveAoNode,
  resolveHbHydrateNodeUrls,
  resolveHbReadNodeUrls,
} from './aoNode';
import { resolveHbReadNodeUrlsForProcess } from './hbScheduler';

export const SCHEDULER_ROUTER_URL = 'https://su-router.ao-testnet.xyz';

export type SchedulerCheck = {
  available: boolean;
  reason: 'no-messages' | 'scheduler-error' | 'scheduler-unavailable' | null;
  status: number | null;
  error?: string;
};

export type HydrateResult = {
  ok: boolean;
  processId: string;
  nodeUrl: string;
  status: number;
  durationMs: number;
  schedulerCheck?: SchedulerCheck;
  skipped?: boolean;
  skipReason?: string;
};

function normalizeBase(url: string): string {
  return String(url || '').trim().replace(/\/+$/, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** HTTP statuses that will not succeed on retry for this process/node pair. */
function isHardHydrateFailure(status: number): boolean {
  return status === 400 || status === 404 || status === 422 || status === 500 || status === 501;
}

/** Check whether the AO scheduler router can serve messages for a process. */
export async function checkProcessSchedulerStatus(
  processId: string,
  schedulerUrl = SCHEDULER_ROUTER_URL
): Promise<SchedulerCheck> {
  const pid = String(processId || '').trim();
  if (!pid) {
    return { available: false, reason: 'scheduler-error', status: null, error: 'missing process id' };
  }
  try {
    const res = await fetch(`${schedulerUrl}/${pid}/latest?proc-id=${pid}`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 400) {
      const body = await res.json().catch(() => ({}));
      if (body?.error === 'Latest message not available') {
        return { available: false, reason: 'no-messages', status: res.status };
      }
      return {
        available: false,
        reason: 'scheduler-error',
        status: res.status,
        error: String(body?.error || 'scheduler error'),
      };
    }
    return { available: res.ok, reason: null, status: res.status };
  } catch (error: any) {
    return {
      available: false,
      reason: 'scheduler-unavailable',
      status: null,
      error: String(error?.message || error),
    };
  }
}

/** True when spawn tags indicate the legacy app-1 scheduler (not reachable on Portal HB). */
export function isLegacySchedulerId(scheduler: string | null | undefined): boolean {
  const value = String(scheduler || '').trim();
  return Boolean(value && value === LEGACY_AO_SCHEDULER);
}

/**
 * Pre-warm HyperBEAM compute cache for a process via GET /now.
 * Mirrors app-1-hb-hydrations/hydrate.js — does not migrate schedulers.
 *
 * Fail-fast on hard 4xx/5xx (no retries) — operator nodes often 500 foreign schedules.
 */
export async function hydrateProcessOnHb(args: {
  processId: string;
  nodeBase?: string;
  timeoutMs?: number;
  retries?: number;
  skipIfSchedulerMissing?: boolean;
  schedulerCheck?: SchedulerCheck | null;
}): Promise<HydrateResult> {
  const processId = String(args.processId || '').trim();
  const nodeUrl = normalizeBase(args.nodeBase || resolveAoNode().url);
  const isOperator = isOperatorHbUrl(nodeUrl);
  // Operator / foreign peers: short timeout, single attempt. Preferred nodes get more patience.
  const timeoutMs = args.timeoutMs ?? (isOperator ? 8_000 : 20_000);
  const retries = Math.max(1, args.retries ?? (isOperator ? 1 : 2));
  const start = Date.now();

  if (!processId) {
    return { ok: false, processId, nodeUrl, status: 0, durationMs: 0, skipReason: 'missing process id' };
  }

  let schedulerCheck = args.schedulerCheck ?? null;
  if (args.skipIfSchedulerMissing) {
    schedulerCheck = schedulerCheck ?? (await checkProcessSchedulerStatus(processId));
    if (!schedulerCheck.available) {
      return {
        ok: false,
        processId,
        nodeUrl,
        status: schedulerCheck.status ?? 0,
        durationMs: Date.now() - start,
        schedulerCheck,
        skipped: true,
        skipReason: schedulerCheck.reason || 'scheduler-unavailable',
      };
    }
  }

  const url = `${nodeUrl}/${processId}~process@1.0/now`;
  let lastStatus = 0;

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await sleep(1500);
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      window.clearTimeout(timer);
      lastStatus = res.status;
      if (res.ok) {
        return {
          ok: true,
          processId,
          nodeUrl,
          status: res.status,
          durationMs: Date.now() - start,
          schedulerCheck: schedulerCheck ?? undefined,
        };
      }
      // Permanent failure for this node/process — do not burn retries (nyc 500 spam).
      if (isHardHydrateFailure(res.status)) {
        break;
      }
    } catch {
      // retry transient network/abort errors only
    }
  }

  return {
    ok: false,
    processId,
    nodeUrl,
    status: lastStatus,
    durationMs: Date.now() - start,
    schedulerCheck: schedulerCheck ?? undefined,
  };
}

export type HydrateProcessOptions = {
  skipIfSchedulerMissing?: boolean;
  waitBetweenMs?: number;
  /**
   * When true (default), include configured operator URL so Portal-scheduled processes
   * can be warmed onto arweave.nyc. Operator is never preferred for *reads* of foreign schedules.
   */
  includeOperator?: boolean;
  /** Cap per-node timeout (ms). */
  timeoutMs?: number;
  /** Max attempts per node (hard 4xx/5xx still exit after first). */
  retries?: number;
  /**
   * When true, hydrate Bazar+Portal (+preferred) first and fire operator in the background
   * so listing confirm does not wait on nyc.
   */
  operatorBackground?: boolean;
};

/**
 * Hydrate on preferred HB nodes for this process (scheduler match first),
 * then Bazar + Portal, then optional operator (hydrate-spread only).
 *
 * Operator hydrate defaults to background so Portal-owned processes never block on
 * arweave.nyc 500s. Pass `operatorBackground: false` to await operator too.
 */
export async function hydrateProcessOnPortalAndBazar(
  processId: string,
  options?: HydrateProcessOptions
): Promise<HydrateResult[]> {
  const schedulerCheck = options?.skipIfSchedulerMissing
    ? await checkProcessSchedulerStatus(processId)
    : null;

  const preferred = await resolveHbReadNodeUrlsForProcess(processId).catch(() => resolveHbReadNodeUrls());
  const includeOperator = options?.includeOperator !== false;
  // Default: never block callers on operator (foreign schedules 500 fast but still noisy).
  const operatorBackground = options?.operatorBackground !== false;
  const allBases = resolveHbHydrateNodeUrls(preferred);
  const operatorUrl = allBases.find((url) => isOperatorHbUrl(url)) || null;

  const blockingBases =
    includeOperator && !operatorBackground
      ? allBases
      : allBases.filter((url) => !isOperatorHbUrl(url));

  // Ensure Portal + Bazar always present even if preferred resolution failed.
  const nodeBases = Array.from(
    new Set(
      [
        ...blockingBases,
        resolveAoNode().url || AO_NODE.url,
        BAZAR_HB_NODE,
      ].map((url) => normalizeBase(url))
    )
  );

  const runOne = (nodeBase: string) =>
    hydrateProcessOnHb({
      processId,
      nodeBase,
      schedulerCheck,
      skipIfSchedulerMissing: options?.skipIfSchedulerMissing,
      timeoutMs: options?.timeoutMs,
      retries: options?.retries,
    });

  const results: HydrateResult[] = [];
  for (let i = 0; i < nodeBases.length; i++) {
    if (i > 0 && options?.waitBetweenMs) await sleep(options.waitBetweenMs);
    results.push(await runOne(nodeBases[i]));
  }

  if (includeOperator && operatorBackground && operatorUrl) {
    void runOne(operatorUrl).catch(() => {});
  }

  return results;
}

/**
 * Fast post-write warm for UCM confirm: Bazar + Portal only (blocking), operator in background.
 * Avoids multi-minute hangs when arweave.nyc 500s foreign Portal schedules.
 */
export async function hydrateProcessForListingConfirm(processId: string): Promise<HydrateResult[]> {
  return hydrateProcessOnPortalAndBazar(processId, {
    waitBetweenMs: 0,
    timeoutMs: 8_000,
    retries: 1,
    includeOperator: true,
    operatorBackground: true,
  });
}
