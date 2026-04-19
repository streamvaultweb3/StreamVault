import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useActiveAddress, useApi, useConnection } from '@arweave-wallet-kit/react';
import { setAnalyticsUserId, setUserProperties, trackEvent } from '../lib/analytics';

export type WalletType = 'arweave' | 'ethereum' | 'solana' | null;

const STORAGE_KEY = 'streamvault:walletType';
const ARWEAVE_PERMISSIONS = ['ACCESS_ADDRESS', 'ACCESS_PUBLIC_KEY', 'SIGN_TRANSACTION', 'SIGNATURE', 'DISPATCH'];

interface WalletContextValue {
  walletType: WalletType;
  address: string | null;
  isConnecting: boolean;
  /** Connects the given wallet type. Returns the address on success, null on failure. */
  connect: (type: WalletType) => Promise<string | null>;
  disconnect: () => void;
  isOwnerOfTrack: (artistId: string) => boolean;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [walletType, setWalletType] = useState<WalletType>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const arweaveAddress = useActiveAddress();
  const arweaveApi = useApi();
  const { connected: arweaveConnected, connect: connectArweaveKit, disconnect: disconnectArweaveKit } = useConnection();

  const getInjectedArweaveAddress = useCallback(async (): Promise<string | null> => {
    const win = typeof window !== 'undefined' ? (window as any) : null;
    const wallet = win?.arweaveWallet;
    if (!wallet?.getActiveAddress) return null;
    try {
      const addr = await wallet.getActiveAddress();
      return typeof addr === 'string' && addr ? addr : null;
    } catch {
      return null;
    }
  }, []);

  // Keep local wallet state in sync with Arweave Wallet Kit session state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Primary source: Wallet Kit hook value
      if (arweaveAddress) {
        if (cancelled) return;
        setWalletType('arweave');
        setAddress(arweaveAddress);
        localStorage.setItem(STORAGE_KEY, 'arweave');
        return;
      }

      // Fallback: injected API (extension or Wander Connect)
      if (arweaveConnected || walletType === 'arweave' || localStorage.getItem(STORAGE_KEY) === 'arweave') {
        const injectedAddress = await getInjectedArweaveAddress();
        if (cancelled) return;
        if (injectedAddress) {
          setWalletType('arweave');
          setAddress(injectedAddress);
          localStorage.setItem(STORAGE_KEY, 'arweave');
          return;
        }
      }

      // If Arweave was active but no longer resolvable, clear stale state.
      if (walletType === 'arweave') {
        setWalletType(null);
        setAddress(null);
        localStorage.removeItem(STORAGE_KEY);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [arweaveConnected, arweaveAddress, walletType, getInjectedArweaveAddress]);

  // Sync again when injected wallet appears (Wander Connect auth complete).
  useEffect(() => {
    const handler = async () => {
      const injectedAddress = await getInjectedArweaveAddress();
      if (!injectedAddress) return;
      setWalletType('arweave');
      setAddress(injectedAddress);
      localStorage.setItem(STORAGE_KEY, 'arweave');
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('arweaveWalletLoaded', handler as any);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('arweaveWalletLoaded', handler as any);
      }
    };
  }, [getInjectedArweaveAddress]);

  // After full-page redirects (e.g. OAuth), wallet injection can appear late.
  // Poll briefly to restore Arweave session without forcing a manual reconnect.
  useEffect(() => {
    if (address || walletType === 'arweave') return;
    if (localStorage.getItem(STORAGE_KEY) !== 'arweave') return;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 20;
    const id = window.setInterval(async () => {
      attempts += 1;
      const injectedAddress = await getInjectedArweaveAddress();
      if (cancelled) return;
      if (injectedAddress) {
        setWalletType('arweave');
        setAddress(injectedAddress);
        localStorage.setItem(STORAGE_KEY, 'arweave');
        window.clearInterval(id);
        return;
      }
      if (attempts >= maxAttempts) {
        window.clearInterval(id);
      }
    }, 900);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [address, getInjectedArweaveAddress, walletType]);

  // On mount: try to silently restore non-Arweave wallets.
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as WalletType | null;
    if (!saved) return;
    if (saved === 'arweave') return;

    let cancelled = false;
    (async () => {
      try {
        if (saved === 'ethereum') {
          const eth = (window as any).ethereum;
          if (!eth || cancelled) return;
          // eth_accounts (no popup) returns already-authorised accounts.
          const accounts: string[] = await eth.request({ method: 'eth_accounts' });
          if (cancelled || !accounts?.length) return;
          setAddress(accounts[0]);
          setWalletType('ethereum');
        } else if (saved === 'solana') {
          const phantom = (window as any).phantom?.solana;
          if (!phantom || cancelled) return;
          // eagerly connect (no popup if already authorised).
          const resp = await phantom.connect({ onlyIfTrusted: true }).catch(() => null);
          if (cancelled || !resp) return;
          setAddress(resp.publicKey?.toString() || null);
          setWalletType('solana');
        }
      } catch {
        // Silently ignore — user will need to manually connect.
        localStorage.removeItem(STORAGE_KEY);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setUserProperties({
      wallet_type: walletType || 'none',
      wallet_connected: Boolean(address),
      wallet_address_prefix: address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'none',
    });
    setAnalyticsUserId(address || null);
  }, [address, walletType]);

  const connect = useCallback(async (type: WalletType): Promise<string | null> => {
      if (!type) return null;
      setIsConnecting(true);
      try {
        let addr: string | null = null;

      if (type === 'arweave') {
        try {
          await connectArweaveKit();
        } catch {
          // Fallback path for injected wallets that are available but not resolved by strategy checks.
          const wallet = (typeof window !== 'undefined' ? (window as any).arweaveWallet : null);
          if (wallet?.connect) {
            await Promise.race([
              wallet.connect(ARWEAVE_PERMISSIONS),
              new Promise((_, reject) =>
                window.setTimeout(() => reject(new Error('Arweave wallet connect timed out.')), 20000)
              ),
            ]);
          } else {
            throw new Error('Wander wallet is not available. Install extension or launch Wander Connect.');
          }
        }

        if (arweaveApi?.getActiveAddress) {
          addr = await arweaveApi.getActiveAddress().catch(() => null);
        }
        if (!addr) {
          addr = await getInjectedArweaveAddress();
        }
        // Fallback to synced hook value if API call isn't immediately available.
        if (!addr && arweaveAddress) addr = arweaveAddress;

      } else if (type === 'ethereum') {
        const eth = (window as any).ethereum;
        if (!eth) throw new Error('No Ethereum wallet detected. Install MetaMask.');
        const accounts: string[] = await eth.request({ method: 'eth_requestAccounts' });
        addr = accounts?.[0] ?? null;

      } else if (type === 'solana') {
        const phantom = (window as any).phantom?.solana;
        if (!phantom) throw new Error('Phantom wallet not detected.');
        const resp = await phantom.connect();
        addr = resp?.publicKey?.toString() ?? null;
      }

      if (addr) {
        setAddress(addr);
        setWalletType(type);
        localStorage.setItem(STORAGE_KEY, type);
        trackEvent('wallet_connect_success', {
          wallet_type: type,
          address_prefix: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
        });
      } else if (type === 'arweave' && arweaveConnected && arweaveAddress) {
        setAddress(arweaveAddress);
        setWalletType('arweave');
        localStorage.setItem(STORAGE_KEY, 'arweave');
        trackEvent('wallet_connect_success', {
          wallet_type: 'arweave',
          address_prefix: `${arweaveAddress.slice(0, 6)}...${arweaveAddress.slice(-4)}`,
        });
        return arweaveAddress;
      }
      return addr;
    } catch (e: any) {
      console.error('[wallet] Connect error', e);
      trackEvent('wallet_connect_failed', {
        wallet_type: type || 'unknown',
        reason: String(e?.message || 'unknown_error').slice(0, 200),
      });
      // Surface the error message so callers can display it.
      throw e;
    } finally {
      setIsConnecting(false);
    }
  }, [arweaveApi, arweaveAddress, arweaveConnected, connectArweaveKit, getInjectedArweaveAddress]);

  const disconnect = useCallback(() => {
    const previousType = walletType;
    if (walletType === 'arweave') {
      disconnectArweaveKit().catch(() => {
        // ignore and clear local state anyway
      });
    }
    setWalletType(null);
    setAddress(null);
    localStorage.removeItem(STORAGE_KEY);
    trackEvent('wallet_disconnect', {
      wallet_type: previousType || 'unknown',
    });
  }, [disconnectArweaveKit, walletType]);

  const isOwnerOfTrack = useCallback(
    (artistId: string) => {
      if (!address) return false;
      return address.toLowerCase() === artistId?.toLowerCase();
    },
    [address]
  );

  return (
    <WalletContext.Provider
      value={{
        walletType,
        address,
        isConnecting,
        connect,
        disconnect,
        isOwnerOfTrack,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}
