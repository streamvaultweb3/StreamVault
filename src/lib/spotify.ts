/** Public catalog search types (Client Credentials / server-side search only). */

export type SpotifyImage = {
  url?: string;
  height?: number | null;
  width?: number | null;
};

export type SpotifyCatalogTrack = {
  id: string;
  name: string;
  artists: { name: string }[];
  album: { name: string; images?: SpotifyImage[] };
  external_urls?: { spotify?: string };
};

export type SpotifyCatalogSearchResponse = {
  tracks?: {
    items: SpotifyCatalogTrack[];
  };
  error?: { message?: string; status?: number };
};

const SEARCH_PATH = '/api/spotify-search';

export async function fetchSpotifyCatalogSearch(
  q: string,
  opts?: { type?: string; signal?: AbortSignal }
): Promise<SpotifyCatalogSearchResponse> {
  const trimmed = q.trim();
  if (!trimmed) {
    return { tracks: { items: [] } };
  }

  const params = new URLSearchParams({ q: trimmed });
  const type = (opts?.type ?? 'track').trim();
  if (type) params.set('type', type);

  const res = await fetch(`${SEARCH_PATH}?${params.toString()}`, {
    method: 'GET',
    signal: opts?.signal,
    headers: { Accept: 'application/json' },
  });

  const text = await res.text();
  let parsed: SpotifyCatalogSearchResponse;
  try {
    parsed = JSON.parse(text) as SpotifyCatalogSearchResponse;
  } catch {
    throw new Error(text.trim() || `Spotify search invalid JSON [HTTP ${res.status}]`);
  }

  if (!res.ok) {
    const msg =
      (parsed as { error?: string }).error ||
      parsed.error?.message ||
      `Spotify search failed [HTTP ${res.status}]`;
    throw new Error(msg);
  }

  return parsed;
}

export function spotifyTrackOpenUrl(track: SpotifyCatalogTrack): string | undefined {
  return track.external_urls?.spotify;
}

export function spotifyTrackArtUrl(track: SpotifyCatalogTrack): string | undefined {
  const images = track.album?.images;
  if (!images?.length) return undefined;
  const sorted = [...images].filter((i) => i.url).sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return sorted[0]?.url;
}

export function spotifyTrackArtistsLabel(track: SpotifyCatalogTrack): string {
  return track.artists.map((a) => a.name).filter(Boolean).join(', ') || 'Unknown artist';
}
