import { AO_NODE, BAZAR_HB_NODE, LEGACY_AO_SCHEDULER, resolveAoNode } from './aoNode';

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
  const timeoutMs = args.timeoutMs ?? 30_000;
  const retries = Math.max(1, args.retries ?? 3);
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
    if (attempt > 0) await sleep(2000);
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
    } catch {
      // retry
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

/** Hydrate on Portal HB and Bazar HB (post-upgrade / new spawns). */
export async function hydrateProcessOnPortalAndBazar(
  processId: string,
  options?: { skipIfSchedulerMissing?: boolean; waitBetweenMs?: number }
): Promise<HydrateResult[]> {
  const schedulerCheck = options?.skipIfSchedulerMissing
    ? await checkProcessSchedulerStatus(processId)
    : null;

  const portal = await hydrateProcessOnHb({
    processId,
    nodeBase: resolveAoNode().url || AO_NODE.url,
    schedulerCheck,
    skipIfSchedulerMissing: options?.skipIfSchedulerMissing,
  });

  if (options?.waitBetweenMs) await sleep(options.waitBetweenMs);

  const bazar = await hydrateProcessOnHb({
    processId,
    nodeBase: BAZAR_HB_NODE,
    schedulerCheck,
    skipIfSchedulerMissing: options?.skipIfSchedulerMissing,
  });

  return [portal, bazar];
}
