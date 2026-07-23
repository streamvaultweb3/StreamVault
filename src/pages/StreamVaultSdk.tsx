import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '../context/WalletContext';
import { usePermaweb } from '../context/PermawebContext';
import {
  createStreamVaultClient,
  type AssetUcmMarketStatus,
  type StreamVaultProfile,
  type StreamVaultProfileResolution,
  type StreamVaultTrack,
} from '../../packages/streamvault-sdk/src';
import styles from './StreamVaultSdk.module.css';

const SDK_INSTALL_COMMAND = 'npm install @streamvault/sdk@alpha @permaweb/libs @permaweb/aoconnect arweave';
const SDK_NPM_URL = 'https://www.npmjs.com/package/@streamvault/sdk';

function shortId(value: string | null | undefined): string {
  const id = String(value || '').trim();
  if (!id) return 'None';
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}...${id.slice(-8)}`;
}

export function StreamVaultSdk() {
  const { address, walletType, connect } = useWallet();
  const { libs } = usePermaweb();
  const [profileRefInput, setProfileRefInput] = useState('');
  const [arioResolver, setArioResolver] = useState<any>(null);
  const [resolution, setResolution] = useState<StreamVaultProfileResolution | null>(null);
  const [profile, setProfile] = useState<StreamVaultProfile | null>(null);
  const [tracks, setTracks] = useState<StreamVaultTrack[]>([]);
  const [marketStatuses, setMarketStatuses] = useState<Record<string, AssetUcmMarketStatus>>({});
  const [marketLoading, setMarketLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installCopied, setInstallCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([import('@ar.io/sdk'), import('@solana/kit')])
      .then(([arioSdk, solanaKit]) => {
        if (cancelled) return;
        const rpc = solanaKit.createSolanaRpc('https://api.mainnet-beta.solana.com');
        setArioResolver((arioSdk as any).ARIO.init({ rpc: rpc as any }));
      })
      .catch(() => {
        if (!cancelled) setArioResolver(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const client = useMemo(() => createStreamVaultClient({ permaweb: libs, ario: arioResolver }), [arioResolver, libs]);
  const targetProfileRef = profileRefInput.trim() || address || '';

  const copyInstallCommand = useCallback(async () => {
    await navigator.clipboard.writeText(SDK_INSTALL_COMMAND);
    setInstallCopied(true);
    window.setTimeout(() => setInstallCopied(false), 1800);
  }, []);

  const loadSdkData = useCallback(async () => {
    const ref = targetProfileRef.trim();
    if (!ref) {
      if (walletType !== 'arweave') {
        await connect('arweave');
      }
      return;
    }

    setLoading(true);
    setError(null);
    setResolution(null);
    setProfile(null);
    setTracks([]);
    setMarketStatuses({});
    try {
      const nextResolution = await client.resolveProfile(ref);
      const nextProfile = nextResolution.profile;
      const nextTracks = nextProfile
        ? await client.getTracksByProfile(nextProfile, { limit: 50 })
        : nextResolution.method === 'wallet'
          ? await client.getTracksByWallet(ref, { limit: 50 })
          : [];
      setResolution(nextResolution);
      setProfile(nextProfile);
      setTracks(nextTracks);

      const assetIds = Array.from(new Set(nextTracks.map((track) => track.assetId).filter(Boolean) as string[])).slice(
        0,
        12
      );
      if (assetIds.length > 0) {
        setMarketLoading(true);
        const marketRows = await Promise.allSettled(
          assetIds.map(async (assetId) => [assetId, await client.getAssetUcmMarketStatus(assetId)] as const)
        );
        const nextStatuses: Record<string, AssetUcmMarketStatus> = {};
        for (const row of marketRows) {
          if (row.status === 'fulfilled') {
            nextStatuses[row.value[0]] = row.value[1];
          }
        }
        setMarketStatuses(nextStatuses);
      }
    } catch (e: any) {
      setError(e?.message || 'SDK demo failed to load this wallet.');
    } finally {
      setLoading(false);
      setMarketLoading(false);
    }
  }, [client, connect, targetProfileRef, walletType]);

  return (
    <div className={styles.page}>
      <section className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Alpha SDK</p>
          <h1>StreamVault SDK</h1>
          <p>
            Test the read-only SDK surface that partner apps can use to pull profile music,
            playable Arweave URLs, atomic asset ids, and UCM marketplace context.
          </p>
        </div>
      </section>

      <section className={styles.panel}>
        <label className={styles.label}>
          Profile reference
          <input
            className={styles.input}
            value={profileRefInput}
            onChange={(event) => setProfileRefInput(event.target.value)}
            placeholder={address || 'Paste an Arweave wallet or profile zone id'}
          />
        </label>
        <button type="button" className={styles.button} onClick={() => void loadSdkData()} disabled={loading}>
          {loading ? 'Loading...' : targetProfileRef ? 'Run SDK lookup' : 'Connect wallet'}
        </button>
        {error ? <p className={styles.error}>{error}</p> : null}
        {resolution ? (
          <p className={styles.muted}>
            Resolved as {resolution.method}
            {resolution.resolvedId ? ` -> ${shortId(resolution.resolvedId)}` : ''}.
          </p>
        ) : null}
        <p className={styles.muted}>
          Alpha lookup supports wallet addresses and profile zone ids. Handle and ArNS lookup need a
          dedicated public index before partners should rely on them.
        </p>
      </section>

      <section className={styles.docsGrid}>
        <article className={styles.docPanel}>
          <h2>1. Install</h2>
          <p>Install the alpha release from npm with its profile-read peer dependencies.</p>
          <pre>{SDK_INSTALL_COMMAND}</pre>
        </article>
        <article className={styles.docPanel}>
          <h2>2. Create Client</h2>
          <p>Initialize permaweb-libs, then pass it into the StreamVault client.</p>
          <pre>{`import { createStreamVaultClient } from '@streamvault/sdk';

const streamvault = createStreamVaultClient({ permaweb });`}</pre>
        </article>
        <article className={styles.docPanel}>
          <h2>3. Load Music</h2>
          <p>Resolve a wallet or profile zone id, then request playable tracks.</p>
          <pre>{`const result = await streamvault.resolveProfile(walletOrProfileId);
const tracks = result.profile
  ? await streamvault.getTracksByProfile(result.profile)
  : [];`}</pre>
        </article>
      </section>

      <section className={styles.panel}>
        <div className={styles.sectionTitleRow}>
          <h2>Production Install</h2>
          <span>0.0.1-alpha.2</span>
        </div>
        <div className={styles.packageBar}>
          <div>
            <p className={styles.packageName}>@streamvault/sdk</p>
            <a href={SDK_NPM_URL} target="_blank" rel="noopener noreferrer">
              View package on npm
            </a>
          </div>
          <div className={styles.installCommand} role="group" aria-label="npm install command">
            <code>{SDK_INSTALL_COMMAND}</code>
            <button type="button" onClick={() => void copyInstallCommand()}>
              {installCopied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
        <div className={styles.installGrid}>
          <div>
            <h3>Package</h3>
            <p className={styles.mono}>@streamvault/sdk</p>
            <p className={styles.muted}>Published on npm with the alpha tag.</p>
          </div>
          <div>
            <h3>Install</h3>
            <p className={styles.mono}>npm install @streamvault/sdk@alpha</p>
            <p className={styles.muted}>Use the alpha tag while the read-only API is stabilizing.</p>
          </div>
          <div>
            <h3>Peer</h3>
            <p className={styles.mono}>@permaweb/libs</p>
            <p className={styles.muted}>Required when reading StreamVault/Bazar profile zones.</p>
          </div>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.sectionTitleRow}>
          <h2>SDK Reference</h2>
          <span>read-only</span>
        </div>
        <div className={styles.referenceGrid}>
          <article className={styles.referenceCard}>
            <span className={styles.referenceBadge}>Client</span>
            <h3>createStreamVaultClient()</h3>
            <p>Creates the read-only SDK client. Use this as the main entry point in partner apps.</p>
          </article>
          <article className={styles.referenceCard}>
            <span className={styles.referenceBadge}>Profile</span>
            <h3>StreamVaultProfile</h3>
            <p>Normalized profile id, owner wallet, display name, handle, media, and profile asset refs.</p>
          </article>
          <article className={styles.referenceCard}>
            <span className={styles.referenceBadge}>Music</span>
            <h3>StreamVaultTrack</h3>
            <p>Playable track model with audio tx id, stream URLs, artwork URL, artist, and atomic asset id.</p>
          </article>
          <article className={styles.referenceCard}>
            <span className={styles.referenceBadge}>Resolve</span>
            <h3>resolveProfile(ref)</h3>
            <p>Accepts a wallet or profile zone id and returns a profile resolution result for routing.</p>
          </article>
          <article className={styles.referenceCard}>
            <span className={styles.referenceBadge}>Library</span>
            <h3>getTracksByProfile()</h3>
            <p>Loads wallet uploads and music atomic assets referenced by the profile zone.</p>
          </article>
          <article className={styles.referenceCard}>
            <span className={styles.referenceBadge}>Market</span>
            <h3>AssetUcmMarketStatus</h3>
            <p>Marketplace status shape for UCM asks. Deeper UCM indexing will expand after alpha.</p>
          </article>
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.sectionTitleRow}>
          <h2>Partner Example</h2>
          <span>copy/paste</span>
        </div>
        <pre className={styles.largeCode}>{`import Arweave from 'arweave';
import Permaweb from '@permaweb/libs';
import { connect } from '@permaweb/aoconnect';
import { createStreamVaultClient } from '@streamvault/sdk';

const ao = connect({ MODE: 'mainnet' });
const permaweb = Permaweb.init({
  ao,
  arweave: Arweave.init({}),
  gateway: 'https://ao-search-gateway.goldsky.com',
});

const streamvault = createStreamVaultClient({ permaweb });
const result = await streamvault.resolveProfile(walletOrProfileId);
const tracks = result.profile
  ? await streamvault.getTracksByProfile(result.profile, { limit: 50 })
  : [];

for (const track of tracks) {
  audio.src = track.streamUrl;
}`}</pre>
      </section>

      <section className={styles.panel}>
        <div className={styles.sectionTitleRow}>
          <h2>Using Returned Data</h2>
          <span>player UI</span>
        </div>
        <div className={styles.dataGrid}>
          <article className={styles.dataCard}>
            <h3>Audio</h3>
            <p>
              Use <code>track.audioTxId</code> as the permanent Arweave transaction id and{' '}
              <code>track.streamUrl</code> as the default playable gateway URL.
            </p>
            <pre>{`audio.src = track.streamUrl;
const audioTxId = track.audioTxId;`}</pre>
          </article>
          <article className={styles.dataCard}>
            <h3>Cover Art</h3>
            <p>
              Use <code>track.artworkUrl</code> directly in image tags. Partners can display it in
              cards, players, playlists, and competition brackets.
            </p>
            <pre>{`<img src={track.artworkUrl} alt={track.title} />`}</pre>
          </article>
          <article className={styles.dataCard}>
            <h3>Metadata</h3>
            <p>
              Use <code>track.title</code>, <code>track.artist</code>, and <code>profile.displayName</code>{' '}
              for display labels and creator attribution.
            </p>
            <pre>{`const title = track.title;
const artist = track.artist;`}</pre>
          </article>
          <article className={styles.dataCard}>
            <h3>Gateway URLs</h3>
            <p>
              The SDK returns gateway URLs, but partners can also append any Arweave transaction id to
              their preferred compatible gateway.
            </p>
            <pre>{`const url = \`https://arweave.net/\${track.audioTxId}\`;
const cover = track.artworkUrl;`}</pre>
          </article>
          <article className={styles.dataCard}>
            <h3>Atomic Asset</h3>
            <p>
              Use <code>track.assetId</code> when you need the AO atomic asset, license context, or
              marketplace status.
            </p>
            <pre>{`const market = track.assetId
  ? await streamvault.getAssetUcmMarketStatus(track.assetId)
  : null;`}</pre>
          </article>
        </div>
      </section>

      {profile ? (
        <section className={styles.panel}>
          <div className={styles.sectionTitleRow}>
            <h2>Profile</h2>
            <span>{shortId(profile.id)}</span>
          </div>
          <div className={styles.profileRow}>
            {profile.avatarUrl ? <img src={profile.avatarUrl} alt="" className={styles.avatar} /> : null}
            <div>
              <p className={styles.profileName}>{profile.displayName || profile.handle || 'Unnamed profile'}</p>
              <p className={styles.muted}>{profile.bio || 'No bio found.'}</p>
              <p className={styles.mono}>Wallet: {shortId(profile.walletAddress)}</p>
              <p className={styles.mono}>Profile assets: {profile.assets.length}</p>
            </div>
          </div>
        </section>
      ) : null}

      <section className={styles.panel}>
        <div className={styles.sectionTitleRow}>
          <h2>Tracks</h2>
          <span>{marketLoading ? 'Reading UCM...' : tracks.length}</span>
        </div>
        {loading ? <p className={styles.muted}>Reading StreamVault uploads...</p> : null}
        {!loading && tracks.length === 0 ? (
          <p className={styles.muted}>No Arweave music uploads found for this wallet yet.</p>
        ) : (
          <div className={styles.trackList}>
            {tracks.map((track) => (
              <article key={`${track.audioTxId}:${track.assetId || ''}`} className={styles.trackCard}>
                {track.artworkUrl ? <img src={track.artworkUrl} alt="" className={styles.cover} /> : null}
                <div className={styles.trackBody}>
                  <h3>{track.title}</h3>
                  <p>{track.artist}</p>
                  <p className={styles.mono}>Audio tx: {shortId(track.audioTxId)}</p>
                  <p className={styles.mono}>Atomic asset: {shortId(track.assetId)}</p>
                  {track.assetId ? (
                    <p className={styles.mono}>
                      UCM asks:{' '}
                      {marketStatuses[track.assetId]
                        ? `${marketStatuses[track.assetId].totalAskCount} via ${
                            marketStatuses[track.assetId].orderbookReadSource
                          }`
                        : marketLoading
                          ? 'checking'
                          : 'not found'}
                    </p>
                  ) : null}
                  <a href={track.streamUrl} target="_blank" rel="noopener noreferrer">
                    Open stream URL
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
