import { useEffect, useRef } from 'react';
import { Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { Artist } from './pages/Artist';
import { ArweaveArtist } from './pages/ArweaveArtist';
import { Profile } from './pages/Profile';
import { CreatorTools } from './pages/CreatorTools';
import { NowPlayingBar } from './components/NowPlayingBar';
import { configureAnalytics, trackPageView } from './lib/analytics';
import { VaultLayout } from './pages/vault/VaultLayout';
import { VaultTrending } from './pages/vault/VaultTrending';
import { VaultExplore } from './pages/vault/VaultExplore';
import { VaultLibrary } from './pages/vault/VaultLibrary';
import { VaultWallet } from './pages/vault/VaultWallet';
import { VaultRewards } from './pages/vault/VaultRewards';
import { VaultPlaceholder } from './pages/vault/VaultPlaceholder';
import { TrackDetail } from './pages/TrackDetail';
import { usePlayer } from './context/PlayerContext';
const GA_MEASUREMENT_ID = 'G-HBLXEBQB7H';

function getPageGroup(pathname: string): string {
  if (pathname.startsWith('/vault')) return 'vault';
  if (pathname.startsWith('/profile')) return 'profile';
  if (pathname.startsWith('/artist')) return 'artist';
  if (pathname.startsWith('/track')) return 'track';
  if (pathname.startsWith('/creator-tools')) return 'creator_tools';
  return 'discover';
}

function RouteAnalytics() {
  const location = useLocation();
  const configuredRef = useRef(false);
  const didTrackFirstRouteRef = useRef(false);

  useEffect(() => {
    if (!configuredRef.current) {
      configureAnalytics(GA_MEASUREMENT_ID);
      configuredRef.current = true;
    }

    const pagePath = `${location.pathname}${location.search}${location.hash}`;
    if (!didTrackFirstRouteRef.current) {
      didTrackFirstRouteRef.current = true;
      return;
    }
    trackPageView(pagePath, undefined, {
      page_group: getPageGroup(location.pathname),
    });
  }, [location.hash, location.pathname, location.search]);

  return null;
}

export default function App() {
  const { currentTrack } = usePlayer();

  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;
    root.classList.toggle('has-player', Boolean(currentTrack));
    return () => {
      root.classList.remove('has-player');
    };
  }, [currentTrack]);

  return (
    <Layout>
      <RouteAnalytics />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/artist/arweave/:address" element={<ArweaveArtist />} />
        <Route path="/artist/:id" element={<Artist />} />
        <Route path="/profile/:address" element={<Profile />} />
        <Route path="/track/:txId" element={<TrackDetail />} />
        <Route path="/creator-tools" element={<Navigate to="/vault/creator-tools" replace />} />
        <Route path="/vault" element={<VaultLayout />}>
          <Route index element={<VaultTrending />} />
          <Route path="feed" element={<VaultPlaceholder title="Feed" message="Tracks from creators you follow. Coming soon." />} />
          <Route path="explore" element={<VaultExplore />} />
          <Route path="library" element={<VaultLibrary />} />
          <Route path="messages" element={<VaultPlaceholder title="Messages" />} />
          <Route path="wallet" element={<VaultWallet />} />
          <Route path="rewards" element={<VaultRewards />} />
          <Route path="playlists" element={<VaultPlaceholder title="Playlists" message="Create and manage playlists on Arweave. Coming soon." />} />
          <Route path="creator-tools" element={<CreatorTools />} />
        </Route>
      </Routes>
      <NowPlayingBar />
    </Layout>
  );
}
