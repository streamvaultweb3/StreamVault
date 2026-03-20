type EnsureWanderConnectArgs = {
  clientId?: string;
  timeoutMs?: number;
};

let initPromise: Promise<void> | null = null;
let wanderInstance: any = null;

function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).arweaveWallet);
}

function waitForInjectedWallet(timeoutMs: number): Promise<void> {
  if (hasInjectedWallet()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    let pollId: number | null = null;
    const cleanup = () => {
      if (pollId != null) window.clearInterval(pollId);
      window.clearTimeout(timeoutId);
      window.removeEventListener('arweaveWalletLoaded', onLoaded);
    };
    const onLoaded = () => {
      if (!hasInjectedWallet()) return;
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const timeoutId = window.setTimeout(() => {
      if (done) return;
      if (hasInjectedWallet()) {
        done = true;
        cleanup();
        resolve();
        return;
      }
      done = true;
      cleanup();
      reject(new Error('Wander Connect timed out waiting for wallet authentication.'));
    }, timeoutMs);

    pollId = window.setInterval(() => {
      if (done) return;
      if (hasInjectedWallet()) {
        done = true;
        cleanup();
        resolve();
      }
    }, 300);

    window.addEventListener('arweaveWalletLoaded', onLoaded, { once: true });

    // One more immediate check after listeners are in place.
    if (hasInjectedWallet()) {
      done = true;
      cleanup();
      resolve();
    }
  });
}

export async function ensureWanderConnect(args: EnsureWanderConnectArgs = {}): Promise<void> {
  if (typeof window === 'undefined' || hasInjectedWallet()) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const { clientId = 'FREE_TRIAL', timeoutMs = 60000 } = args;
    const mod = await import('@wanderapp/connect');
    const WanderConnect = (mod as any).WanderConnect;
    if (!WanderConnect) throw new Error('Wander Connect SDK failed to load.');
    // Avoid retaining an old instance between retries.
    destroyWanderConnect();
    // Keep control in app UI (no auto floating button injected by SDK).
    wanderInstance = new WanderConnect({ clientId, button: false });
    await waitForInjectedWallet(timeoutMs);
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

export function openWanderConnect(): void {
  try {
    wanderInstance?.open?.();
  } catch {
    // ignore; caller can still rely on wallet.connect request flow
  }
}

export function destroyWanderConnect(): void {
  try {
    wanderInstance?.destroy?.();
  } catch {
    // ignore
  }
  wanderInstance = null;
}
