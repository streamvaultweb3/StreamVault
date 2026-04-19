import { useState } from 'react';
import { queryAudioTransactions, queryAudioByTag, aoRecordsToTracks } from '../../lib/arweaveDiscovery';
import { searchTracksOnAO } from '../../lib/aoMusicRegistry';
import { TrackCard } from '../../components/TrackCard';
import type { Track } from '../../context/PlayerContext';
import styles from './Vault.module.css';

export function VaultExplore() {
  const [query, setQuery] = useState('');
  const [tagName, setTagName] = useState('');
  const [tagValue, setTagValue] = useState('');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const hasTag = tagName.trim() && tagValue.trim();
      let gqlTracks: Track[] = [];
      let aoTracks: Track[] = [];
      if (hasTag) {
        gqlTracks = await queryAudioByTag(tagName.trim(), tagValue.trim(), 50);
        const aoRecords = await searchTracksOnAO({ tagName: tagName.trim(), tagValue: tagValue.trim() });
        aoTracks = aoRecordsToTracks(aoRecords);
      } else {
        gqlTracks = await queryAudioTransactions({ limit: 50 });
        const aoRecords = await searchTracksOnAO({});
        aoTracks = aoRecordsToTracks(aoRecords);
      }
      const byId = new Map<string, Track>();
      gqlTracks.forEach((t) => byId.set(t.id, t));
      aoTracks.forEach((t) => {
        if (!byId.has(t.id)) byId.set(t.id, t);
      });
      let result = Array.from(byId.values());
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        result = result.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.artist.toLowerCase().includes(q)
        );
      }
      setTracks(result);
    } catch (e: any) {
      setError(e?.message ?? 'Search failed.');
      setTracks([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <h1 className={styles.sectionTitle}>Explore</h1>
      <p className={styles.sectionSubtitle}>
        Search by keyword or filter by tag (e.g. Genre, Mood, BPM).
      </p>
      <div className={styles.searchRow}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search by title or artist"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Tag name (e.g. Genre)"
          value={tagName}
          onChange={(e) => setTagName(e.target.value)}
        />
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Tag value"
          value={tagValue}
          onChange={(e) => setTagValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
        />
        <button
          type="button"
          className={styles.searchBtn}
          onClick={handleSearch}
          disabled={loading}
        >
          {loading ? 'Searching…' : 'Search'}
        </button>
      </div>
      {error && <p className={styles.errorText}>{error}</p>}
      {loading ? (
        <p className={styles.loading}>Loading…</p>
      ) : (
        <section className={styles.grid}>
          {tracks.map((track) => (
            <TrackCard
              key={track.id}
              track={track}
              artistHref={track.artistId && track.artistId.length > 20 ? `/profile/${track.artistId}` : undefined}
            />
          ))}
        </section>
      )}
      {searched && !loading && !error && tracks.length === 0 && (
        <p className={styles.placeholderBox}>No tracks match your search.</p>
      )}
    </>
  );
}
