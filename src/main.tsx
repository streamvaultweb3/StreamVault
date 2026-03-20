import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './context/ThemeContext';
import { WalletProvider } from './context/WalletContext';
import { PlayerProvider } from './context/PlayerContext';
import { PermawebProvider } from './context/PermawebContext';
import { GeneratedCoverProvider } from './context/GeneratedCoverContext';
import { GeneratedAudioProvider } from './context/GeneratedAudioContext';
import { AudiusAuthProvider } from './context/AudiusAuthContext';
import { ArweaveWalletKit } from '@arweave-wallet-kit/react';
import WanderStrategy from '@arweave-wallet-kit/wander-strategy';
import BrowserWalletStrategy from '@arweave-wallet-kit/browser-wallet-strategy';
import AoSyncStrategy from '@vela-ventures/aosync-strategy';
import './styles/global.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <ThemeProvider>
        <AudiusAuthProvider>
          <ArweaveWalletKit
            config={{
              permissions: [
                'ACCESS_ADDRESS',
                'ACCESS_PUBLIC_KEY',
                'SIGN_TRANSACTION',
                'DISPATCH',
              ],
              ensurePermissions: true,
              strategies: [
                new WanderStrategy(),
                new BrowserWalletStrategy(),
                new AoSyncStrategy(),
              ],
              appInfo: {
                name: 'StreamVault',
              },
              gatewayConfig: {
                host: 'arweave.net',
                port: 443,
                protocol: 'https',
              },
            }}
          >
            <WalletProvider>
              <PermawebProvider>
                <GeneratedCoverProvider>
                  <GeneratedAudioProvider>
                    <PlayerProvider>
                      <App />
                    </PlayerProvider>
                  </GeneratedAudioProvider>
                </GeneratedCoverProvider>
              </PermawebProvider>
            </WalletProvider>
          </ArweaveWalletKit>
        </AudiusAuthProvider>
      </ThemeProvider>
    </HashRouter>
  </React.StrictMode>
);
