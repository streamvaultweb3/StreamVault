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

function buildPushAttemptUrls(baseUrl: string, writeNodeUrls?: string[]): string[] {
  const baseOrigin = new URL(baseUrl, window.location.href).origin.replace(/\/+$/, '');
  const nodes = writeNodeUrls?.length
    ? [...new Set(writeNodeUrls.map((node) => node.replace(/\/+$/, '')))]
    : [baseOrigin];
  const urls: string[] = [];
  for (const node of nodes) {
    const hostUrl = node === baseOrigin ? baseUrl : rewritePushHost(baseUrl, node);
    urls.push(withQueryParam(hostUrl, 'async', 'true'));
    urls.push(hostUrl);
    urls.push(rewritePushToSchedule(hostUrl));
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

/** Retry transient Portal HyperBEAM push/read failures (ERR_CONNECTION_CLOSED, etc.). */
export function createResilientAoFetch(options?: {
  retries?: number;
  baseDelayMs?: number;
  pushAttemptTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Alternate HyperBEAM origins to try when push to the primary node fails. */
  writeNodeUrls?: string[];
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
    const urls = isPush ? buildPushAttemptUrls(baseUrl, options?.writeNodeUrls) : [baseUrl];
    let lastError: unknown;

    for (const [urlIndex, url] of urls.entries()) {
      for (let attempt = 0; attempt < retries; attempt++) {
        const request = new Request(url, baseRequest.clone());
        const attemptSignal = isPush
          ? createAttemptSignal(baseRequest.signal, pushAttemptTimeoutMs)
          : null;
        const requestWithSignal = attemptSignal
          ? new Request(request, { signal: attemptSignal.signal })
          : request;
        try {
          const response = await fetchImpl(requestWithSignal);
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
