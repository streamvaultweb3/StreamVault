const AUDIUS_API = 'https://api.audius.co/v1';
const APP_NAME = import.meta.env.VITE_AUDIUS_APP_NAME || 'StreamVault';
const AUDIUS_BEARER = import.meta.env.VITE_AUDIUS_BEARER_TOKEN as string | undefined;

export interface AudiusTrack {
  id: string;
  title: string;
  user_id: string | number;
  user: {
    id: string;
    name: string;
    handle: string;
    profile_picture?: { '150x150'?: string; '480x480'?: string; '1000x1000'?: string };
  };
  artwork?: { '150x150'?: string; '480x480'?: string; '1000x1000'?: string };
  duration: number;
  permalink: string;
  stream?: { url?: string };
}

export interface AudiusUser {
  id: string;
  user_id?: number | string;
  name: string;
  handle: string;
  profile_picture?: { '150x150'?: string; '480x480'?: string; '1000x1000'?: string };
  cover_photo?: { '640x'?: string; '2000x'?: string };
  track_count: number;
  playlist_count?: number;
  follower_count?: number;
}

export interface AudiusPlaylist {
  id: string;
  playlist_name: string;
  description?: string;
  track_count: number;
  permalink: string;
  artwork?: { '150x150'?: string; '480x480'?: string; '1000x1000'?: string };
  user: {
    id: string;
    name: string;
    handle: string;
  };
}

export interface AudiusAlbum {
  id: string;
  playlist_name: string;
  description?: string;
  track_count: number;
  permalink: string;
  artwork?: { '150x150'?: string; '480x480'?: string; '1000x1000'?: string };
  user: {
    id: string;
    name: string;
    handle: string;
  };
}

async function fetchApi<T>(path: string): Promise<T> {
  const url = new URL(`${AUDIUS_API}${path}`);
  url.searchParams.set('app_name', APP_NAME);
  const res = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      ...(AUDIUS_BEARER ? { Authorization: `Bearer ${AUDIUS_BEARER}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`Audius API: ${res.status}`);
  return res.json();
}

export async function getTrendingTracks(limit = 20): Promise<AudiusTrack[]> {
  const data = await fetchApi<{ data: AudiusTrack[] }>(`/tracks/trending?limit=${limit}`);
  return data.data || [];
}

export async function searchTracks(q: string, limit = 20): Promise<AudiusTrack[]> {
  const data = await fetchApi<{ data: AudiusTrack[] }>(
    `/tracks/search?query=${encodeURIComponent(q)}&limit=${limit}`
  );
  return data.data || [];
}

export async function searchUsers(q: string, limit = 5): Promise<AudiusUser[]> {
  const data = await fetchApi<{ data: AudiusUser[] }>(
    `/users/search?query=${encodeURIComponent(q)}&limit=${limit}`
  );
  return data.data || [];
}

export async function getUserByHandle(handle: string): Promise<AudiusUser | null> {
  try {
    const data = await fetchApi<{ data: AudiusUser }>(`/users/handle/${encodeURIComponent(handle)}`);
    return data.data || null;
  } catch {
    return null;
  }
}

export async function getTrackById(id: string): Promise<AudiusTrack | null> {
  try {
    const data = await fetchApi<{ data: AudiusTrack }>(`/tracks/${id}`);
    return data.data || null;
  } catch {
    return null;
  }
}

export async function getUserById(id: string): Promise<AudiusUser | null> {
  try {
    const data = await fetchApi<{ data: AudiusUser }>(`/users/${id}`);
    return data.data || null;
  } catch {
    return null;
  }
}

export async function getUserTracks(userId: string, limit = 20): Promise<AudiusTrack[]> {
  const data = await fetchApi<{ data: AudiusTrack[] }>(
    `/users/${userId}/tracks?limit=${limit}`
  );
  return data.data || [];
}

export async function getUserPlaylists(userId: string, limit = 20): Promise<AudiusPlaylist[]> {
  const data = await fetchApi<{ data: AudiusPlaylist[] }>(
    `/users/${userId}/playlists?limit=${limit}`
  );
  return data.data || [];
}

export async function getUserAlbums(userId: string, limit = 20): Promise<AudiusAlbum[]> {
  const data = await fetchApi<{ data: AudiusAlbum[] }>(
    `/users/${userId}/albums?limit=${limit}`
  );
  return data.data || [];
}

export async function getPlaylistTracks(playlistId: string, limit = 20): Promise<AudiusTrack[]> {
  const data = await fetchApi<{ data: AudiusTrack[] }>(
    `/playlists/${playlistId}/tracks?limit=${limit}`
  );
  return data.data || [];
}

/** Prefer signed stream URL from payload; fallback to API stream endpoint. */
export function getStreamUrl(track: AudiusTrack): string {
  if (track.stream?.url) return track.stream.url;
  return `${AUDIUS_API}/tracks/${track.id}/stream?app_name=${encodeURIComponent(APP_NAME)}`;
}

export function getArtworkUrl(track: AudiusTrack): string | null {
  return (
    track.artwork?.['480x480'] ||
    track.artwork?.['150x150'] ||
    track.user.profile_picture?.['480x480'] ||
    track.user.profile_picture?.['150x150'] ||
    null
  );
}
