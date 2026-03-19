import { Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { Artist } from './pages/Artist';
import { Profile } from './pages/Profile';
import { CreatorTools } from './pages/CreatorTools';
import { NowPlayingBar } from './components/NowPlayingBar';
import { VaultLayout } from './pages/vault/VaultLayout';
import { VaultTrending } from './pages/vault/VaultTrending';
import { VaultExplore } from './pages/vault/VaultExplore';
import { VaultLibrary } from './pages/vault/VaultLibrary';
import { VaultWallet } from './pages/vault/VaultWallet';
import { VaultRewards } from './pages/vault/VaultRewards';
import { VaultPlaceholder } from './pages/vault/VaultPlaceholder';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/artist/:id" element={<Artist />} />
        <Route path="/profile/:address" element={<Profile />} />
        <Route path="/creator-tools" element={<CreatorTools />} />
        <Route path="/vault" element={<VaultLayout />}>
          <Route index element={<VaultTrending />} />
          <Route path="feed" element={<VaultPlaceholder title="Feed" message="Tracks from creators you follow. Coming soon." />} />
          <Route path="explore" element={<VaultExplore />} />
          <Route path="library" element={<VaultLibrary />} />
          <Route path="messages" element={<VaultPlaceholder title="Messages" />} />
          <Route path="wallet" element={<VaultWallet />} />
          <Route path="rewards" element={<VaultRewards />} />
          <Route path="playlists" element={<VaultPlaceholder title="Playlists" message="Create and manage playlists on Arweave. Coming soon." />} />
        </Route>
      </Routes>
      <NowPlayingBar />
    </Layout>
  );
}
