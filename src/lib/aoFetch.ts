const aoFetchDebug =
  import.meta.env.DEV &&
  String(import.meta.env.VITE_DEBUG_AO || import.meta.env.VITE_DEBUG_PROFILE || '') === '1';

const DEFAULT_PUSH_ATTEMPT_TIMEOUT_MS = 12_000;

function isRetryableAoFetchError(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message || error || '');
  return (
    error instanceof TypeError ||
    /HTTP request failed|request failed|failed to fetch|network|ERR_CONNECTION|connection closed|Error sending message|abort|timed out/i.test(
      msg
    )
  );
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Process message push/schedule and root spawn push (`/push`, `/schedule`). */
function isAoPushRequest(url: string, method: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  try {
    const path = new URL(url, window.location.href).pathname.replace(/\/+$/, '');
    return path.endsWith('/push') || path.endsWith('/schedule');
  } catch {
    return false;
  }
}

/** Never route debug/local/non-AO traffic through push retry logic. */
function shouldPassthroughResilientFetch(url: string, method: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (parsed.pathname.includes('/ingest/')) return true;
    return !isAoPushRequest(url, method);
  } catch {
    return true;
  }
}

function withQueryParam(url: string, key: string, value: string): string {
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function rewritePushToSchedule(url: string): string {
  const parsed = new URL(url, window.location.href);
  parsed.pathname = parsed.pathname.replace(/\/push$/, '/schedule');
  parsed.searchParams.delete('async');
  parsed.searchParams.delete('max-depth');
  return parsed.toString();
}

function rewritePushHost(url: string, nodeBase: string): string {
  const parsed = new URL(url, window.location.href);
  const node = nodeBase.replace(/\/+$/, '');
  const origin = new URL(node.endsWith('/') ? node : `${node}/`).origin;
  return `${origin}${parsed.pathname}${parsed.search}`;
}

function buildPushAttemptUrls(
  baseUrl: string,
  writeNodeUrls?: string[],
  opts?: { hostFailoverFirst?: boolean; preferSyncPush?: boolean }
): string[] {
  const baseOrigin = new URL(baseUrl, window.location.href).origin.replace(/\/+$/, '');
  const nodes = writeNodeUrls?.length
    ? [...new Set(writeNodeUrls.map((node) => node.replace(/\/+$/, '')))]
    : [baseOrigin];

  // Default (mint/spawn): async first so Portal hangs do not burn the user-gesture window.
  // UCM Create-Order Transfer: sync first so push@1.0 forwards Credit-Notice onto the
  // orderbook schedule (async ack often leaves escrowed copies with Orderbook: []).
  // max-depth asks push@1.0 to continue outbox forwarding (CN → orderbook) in one call.
  const syncPushVariants = (hostUrl: string) => [
    withQueryParam(hostUrl, 'max-depth', '5'),
    hostUrl,
    rewritePushToSchedule(hostUrl),
  ];
  const variantsFor = (hostUrl: string) =>
    opts?.preferSyncPush
      ? [...syncPushVariants(hostUrl), withQueryParam(hostUrl, 'async', 'true')]
      : [withQueryParam(hostUrl, 'async', 'true'), hostUrl, rewritePushToSchedule(hostUrl)];

  const urls: string[] = [];
  if (opts?.hostFailoverFirst && !opts?.preferSyncPush) {
    // Mint/spawn: try async on every host before burning minutes on Portal plain/schedule.
    for (const node of nodes) {
      const hostUrl = node === baseOrigin ? baseUrl : rewritePushHost(baseUrl, node);
      urls.push(withQueryParam(hostUrl, 'async', 'true'));
    }
    for (const node of nodes) {
      const hostUrl = node === baseOrigin ? baseUrl : rewritePushHost(baseUrl, node);
      urls.push(hostUrl);
      urls.push(rewritePushToSchedule(hostUrl));
    }
  } else if (opts?.preferSyncPush) {
    // Sync (+ max-depth outbox forward, schedule rewrite) before any async fallback.
    for (const node of nodes) {
      const hostUrl = node === baseOrigin ? baseUrl : rewritePushHost(baseUrl, node);
      urls.push(...syncPushVariants(hostUrl));
    }
    for (const node of nodes) {
      const hostUrl = node === baseOrigin ? baseUrl : rewritePushHost(baseUrl, node);
      urls.push(withQueryParam(hostUrl, 'async', 'true'));
    }
  } else {
    for (const node of nodes) {
      const hostUrl = node === baseOrigin ? baseUrl : rewritePushHost(baseUrl, node);
      urls.push(...variantsFor(hostUrl));
    }
  }

  const seen = new Set<string>();
  return urls.filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function isRetryableAoResponse(response: Response): boolean {
  return response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
}

/** Temporary redirects that must re-POST with the same signed body (HB #1005 provenance). */
function isPreserveMethodRedirect(status: number): boolean {
  return status === 307 || status === 308;
}

/**
 * Re-issue a push to Location while cloning the original Request (headers + body).
 * Avoids fetch redirect:'follow' dropping signed HTTP message provenance (`from-*` /
 * target policy) when Portal redirects to a peer (see HyperBEAM #1005).
 */
async function followPushRedirectPreservingProvenance(
  fetchImpl: typeof fetch,
  request: Request,
  response: Response,
  signal: AbortSignal | null
): Promise<Response | null> {
  if (!isPreserveMethodRedirect(response.status)) return null;
  const location = response.headers.get('Location') || response.headers.get('location');
  if (!location) return null;
  try {
    const nextUrl = new URL(location, request.url).toString();
    // Clone preserves signed HTTP message headers/body (`from-*`, target policy).
    const redirected = new Request(nextUrl, {
      method: request.method,
      headers: request.headers,
      body: await request.clone().arrayBuffer(),
      signal: signal || undefined,
      redirect: 'manual',
    });
    return await fetchImpl(redirected);
  } catch {
    return null;
  }
}

function createAttemptSignal(parentSignal: AbortSignal | null, timeoutMs: number) {
  const controller = new AbortController();
  let settled = false;
  const abortFromParent = () => {
    if (settled) return;
    controller.abort(parentSignal?.reason);
  };
  const timeout = window.setTimeout(() => {
    if (settled) return;
    controller.abort(new DOMException('AO process push attempt timed out', 'TimeoutError'));
  }, timeoutMs);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      settled = true;
      window.clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

/**
 * @permaweb/aoconnect mainnet spawn uses ao-core-libs, which calls the **global** `fetch`
 * and ignores `connect({ fetch })`. Temporarily wrap globalThis.fetch so AO `/push` spawn
 * gets Portal→Bazar failover + retries (same resilient logic as message push).
 */
export async function withResilientGlobalFetch<T>(
  fn: () => Promise<T>,
  options?: {
    retries?: number;
    baseDelayMs?: number;
    pushAttemptTimeoutMs?: number;
    writeNodeUrls?: string[];
    /** Try each write host faster (Portal hang → Bazar) — for atomic spawn/mint. */
    hostFailoverFirst?: boolean;
    /**
     * Prefer sync `/push` before `async=true` (UCM Create-Order Transfer).
     * Async-first often acks the asset Transfer without forwarding Credit-Notice
     * onto the orderbook schedule → escrowed copies, Orderbook still [].
     */
    preferSyncPush?: boolean;
  }
): Promise<T> {
  const g = globalThis as typeof globalThis & { fetch: typeof fetch };
  const previous = g.fetch.bind(g);
  const resilient = createResilientAoFetch({
    fetchImpl: previous,
    // One attempt per URL stage — hostFailoverFirst moves to Bazar quickly when Portal hangs.
    retries: options?.retries ?? 1,
    baseDelayMs: options?.baseDelayMs ?? 500,
    pushAttemptTimeoutMs: options?.pushAttemptTimeoutMs ?? 10_000,
    writeNodeUrls: options?.writeNodeUrls,
    hostFailoverFirst: options?.hostFailoverFirst ?? true,
    preferSyncPush: options?.preferSyncPush,
  });
  g.fetch = resilient as typeof fetch;
  try {
    return await fn();
  } finally {
    g.fetch = previous;
  }
}

/** Retry transient Portal HyperBEAM push/read failures (ERR_CONNECTION_CLOSED, etc.). */
export function createResilientAoFetch(options?: {
  retries?: number;
  baseDelayMs?: number;
  pushAttemptTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Alternate HyperBEAM origins to try when push to the primary node fails. */
  writeNodeUrls?: string[];
  /** Prefer trying Portal then Bazar async before exhausting all Portal URL variants. */
  hostFailoverFirst?: boolean;
  /**
   * Prefer sync `/push` (and `/schedule`) before `?async=true`.
   * Use for UCM listing Transfers so Credit-Notice is pushed to the orderbook.
   */
  preferSyncPush?: boolean;
}) {
  const retries = Math.max(1, options?.retries ?? 2);
  const baseDelayMs = options?.baseDelayMs ?? 750;
  const pushAttemptTimeoutMs = options?.pushAttemptTimeoutMs ?? DEFAULT_PUSH_ATTEMPT_TIMEOUT_MS;
  const fetchImpl = options?.fetchImpl ?? fetch;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const baseRequest = new Request(input, init);
    const baseUrl = getRequestUrl(baseRequest);
    if (shouldPassthroughResilientFetch(baseUrl, baseRequest.method)) {
      return fetchImpl(baseRequest);
    }
    const isPush = isAoPushRequest(baseUrl, baseRequest.method);
    const urls = isPush
      ? buildPushAttemptUrls(baseUrl, options?.writeNodeUrls, {
          hostFailoverFirst: options?.hostFailoverFirst,
          preferSyncPush: options?.preferSyncPush,
        })
      : [baseUrl];
    let lastError: unknown;

    for (const [urlIndex, url] of urls.entries()) {
      for (let attempt = 0; attempt < retries; attempt++) {
        // Host rewrite (Portal → Bazar/operator) keeps Request.clone() — signed body +
        // headers stay intact; only origin changes for schedule ownership failover.
        const request = new Request(url, baseRequest.clone());
        const attemptSignal = isPush
          ? createAttemptSignal(baseRequest.signal, pushAttemptTimeoutMs)
          : null;
        const requestWithSignal = attemptSignal
          ? new Request(request, {
              signal: attemptSignal.signal,
              ...(isPush ? { redirect: 'manual' as RequestRedirect } : {}),
            })
          : isPush
            ? new Request(request, { redirect: 'manual' })
            : request;
        try {
          let response = await fetchImpl(requestWithSignal);
          if (isPush && isPreserveMethodRedirect(response.status)) {
            // Re-POST to Location with a fresh clone so provenance headers survive (HB #1005).
            const followed = await followPushRedirectPreservingProvenance(
              fetchImpl,
              new Request(url, baseRequest.clone()),
              response,
              attemptSignal?.signal || baseRequest.signal
            );
            if (followed) {
              if (aoFetchDebug) {
                console.info('[ao:fetch] push 307/308 followed with preserved headers', {
                  from: url,
                  to: followed.url,
                  status: followed.status,
                });
              }
              response = followed;
            }
          }
          attemptSignal?.cleanup();
          if (!isPush || !isRetryableAoResponse(response)) return response;
          lastError = new Error(`AO process push failed with HTTP ${response.status}`);
          if (aoFetchDebug) {
            console.info('[ao:fetch] push response retry', {
              attempt: attempt + 1,
              stage: urlIndex + 1,
              status: response.status,
              url,
            });
          }
        } catch (error) {
          attemptSignal?.cleanup();
          lastError = error;
          if (!isRetryableAoFetchError(error) && (error as { name?: string })?.name !== 'TimeoutError') {
            throw error;
          }
          if (aoFetchDebug) {
            console.info('[ao:fetch] retry', {
              attempt: attempt + 1,
              stage: urlIndex + 1,
              url,
              error: String((error as { message?: string })?.message || error),
            });
          }
        }

        const finalAttemptForStage = attempt >= retries - 1;
        const finalStage = urlIndex >= urls.length - 1;
        if (finalAttemptForStage && finalStage) break;
        if (!finalAttemptForStage) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await sleep(delay);
        }
      }
    }
    throw lastError;
  };
}
