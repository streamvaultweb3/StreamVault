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
  return audiusApiStreamUrl(track.id);
}

/** Audius API stream endpoint — redirects to a fresh signed CDN URL on each request. */
export function audiusApiStreamUrl(trackId: string): string {
  return `${AUDIUS_API}/tracks/${encodeURIComponent(trackId)}/stream?app_name=${encodeURIComponent(APP_NAME)}`;
}

export type AudiusStreamFetchErrorKind =
  | 'network'
  | 'cors'
  | 'http'
  | 'not-audio'
  | 'empty'
  | 'too-large';

export class AudiusStreamFetchError extends Error {
  readonly kind: AudiusStreamFetchErrorKind;
  readonly status?: number;

  constructor(kind: AudiusStreamFetchErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AudiusStreamFetchError';
    this.kind = kind;
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBrowserNetworkError(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message || err || '');
  return /Failed to fetch|NetworkError|Load failed|network|ECONNRESET|ETIMEDOUT|aborted|AbortError/i.test(
    msg
  );
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function shouldTryNextUrl(err: unknown): boolean {
  if (err instanceof AudiusStreamFetchError) {
    if (err.kind === 'too-large' || err.kind === 'not-audio' || err.kind === 'empty') return false;
    if (err.kind === 'http' && err.status != null) {
      return err.status === 401 || err.status === 403 || err.status === 404 || isRetryableHttpStatus(err.status);
    }
    return err.kind === 'network' || err.kind === 'cors' || err.kind === 'http';
  }
  return isBrowserNetworkError(err);
}

function shouldRetrySameUrl(err: unknown): boolean {
  if (err instanceof AudiusStreamFetchError) {
    if (err.kind === 'network' || err.kind === 'cors') return true;
    if (err.kind === 'http' && err.status != null) return isRetryableHttpStatus(err.status);
    return false;
  }
  return isBrowserNetworkError(err);
}

/** Ordered stream URL candidates: fresh API payload, API redirect endpoint, then cached URL. */
export async function resolveAudiusStreamUrlCandidates(
  trackId: string,
  cachedUrl?: string
): Promise<string[]> {
  const urls: string[] = [];
  const push = (url?: string | null) => {
    const value = String(url || '').trim();
    if (value && !urls.includes(value)) urls.push(value);
  };

  try {
    const track = await getTrackById(trackId);
    if (track) push(getStreamUrl(track));
  } catch {
    // Continue with API redirect + cached URL.
  }

  push(audiusApiStreamUrl(trackId));
  push(cachedUrl);
  return urls;
}

async function downloadAudiusStreamFromUrl(url: string, maxBytes: number): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(url, { mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow' });
  } catch (err) {
    throw new AudiusStreamFetchError(
      isBrowserNetworkError(err) ? 'cors' : 'network',
      isBrowserNetworkError(err)
        ? 'Browser blocked the Audius stream request (network or CORS). Upload the audio file from disk, or retry after refreshing the page.'
        : 'Network error while downloading the Audius stream. Check your connection or VPN, then retry.',
      undefined
    );
  }

  if (!res.ok) {
    const status = res.status;
    let message = `Audius stream returned HTTP ${status}.`;
    if (status === 401 || status === 403) {
      message =
        'Audius denied access to the stream URL (likely an expired signed link). Refresh the page and retry, or upload the audio file from disk.';
    } else if (status === 404) {
      message = 'Audius stream was not found. The track may have been removed; upload the audio file from disk instead.';
    } else if (status === 429) {
      message = 'Audius rate-limited the stream request. Wait a moment and retry, or upload the audio file from disk.';
    } else if (status >= 500) {
      message = `Audius CDN error (${status}). Retry in a moment or upload the audio file from disk.`;
    } else {
      message += ' Upload the audio file from disk, or retry later.';
    }
    throw new AudiusStreamFetchError('http', message, status);
  }

  const contentType = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
  if (!contentType.startsWith('audio/')) {
    throw new AudiusStreamFetchError(
      'not-audio',
      `Stream URL returned ${contentType || 'non-audio'} instead of audio. Upload the file manually.`
    );
  }

  const lenHeader = res.headers.get('content-length');
  if (lenHeader) {
    const total = Number(lenHeader);
    if (Number.isFinite(total) && total > maxBytes) {
      throw new AudiusStreamFetchError(
        'too-large',
        `Track is larger than ${Math.round(maxBytes / (1024 * 1024))}MB. Enable Turbo for larger uploads or use a shorter file.`
      );
    }
    if (Number.isFinite(total) && total <= 0) {
      throw new AudiusStreamFetchError('empty', 'Audius stream response was empty. Retry or upload the audio file from disk.');
    }
  }

  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength <= 0) {
      throw new AudiusStreamFetchError('empty', 'Audius stream response was empty. Retry or upload the audio file from disk.');
    }
    if (buf.byteLength > maxBytes) {
      throw new AudiusStreamFetchError(
        'too-large',
        `Track exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit.`
      );
    }
    return new Blob([buf], { type: contentType });
  }

  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (received + value.byteLength > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new AudiusStreamFetchError(
            'too-large',
            `Track exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit.`
          );
        }
        chunks.push(value);
        received += value.byteLength;
      }
    }
  } catch (err) {
    if (err instanceof AudiusStreamFetchError) throw err;
    throw new AudiusStreamFetchError(
      'network',
      'Download interrupted before the full track was received. Retry or upload the audio file from disk.'
    );
  }

  if (received <= 0) {
    throw new AudiusStreamFetchError('empty', 'Audius stream response was empty. Retry or upload the audio file from disk.');
  }

  return new Blob(chunks as BlobPart[], { type: contentType });
}

const STREAM_RETRY_DELAYS_MS = [600, 1500, 3000];

/**
 * Download the full Audius stream into a Blob (browser).
 * Refreshes signed CDN URLs from the Audius API when `audiusTrackId` is provided.
 */
export async function fetchAudiusStreamAsBlob(
  streamUrl: string,
  opts?: { maxBytes?: number; audiusTrackId?: string }
): Promise<Blob> {
  const maxBytes = opts?.maxBytes ?? 10 * 1024 * 1024;
  const candidates =
    opts?.audiusTrackId != null && String(opts.audiusTrackId).trim()
      ? await resolveAudiusStreamUrlCandidates(String(opts.audiusTrackId).trim(), streamUrl)
      : [streamUrl].filter(Boolean);

  if (candidates.length === 0) {
    throw new AudiusStreamFetchError(
      'network',
      'No Audius stream URL available. Upload the audio file from disk instead.'
    );
  }

  let lastError: unknown;
  for (let urlIndex = 0; urlIndex < candidates.length; urlIndex += 1) {
    const url = candidates[urlIndex];
    const maxAttempts = urlIndex === 0 ? STREAM_RETRY_DELAYS_MS.length + 1 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await downloadAudiusStreamFromUrl(url, maxBytes);
      } catch (err) {
        lastError = err;
        const retrySame = shouldRetrySameUrl(err) && attempt < maxAttempts - 1;
        if (retrySame) {
          await sleep(STREAM_RETRY_DELAYS_MS[Math.min(attempt, STREAM_RETRY_DELAYS_MS.length - 1)]);
          continue;
        }
        if (shouldTryNextUrl(err) && urlIndex < candidates.length - 1) break;
        throw err;
      }
    }
  }

  if (lastError instanceof AudiusStreamFetchError) throw lastError;
  if (lastError instanceof Error) throw lastError;
  throw new AudiusStreamFetchError(
    'network',
    'Could not download the full track from the Audius stream. Upload the audio file from disk instead, or retry later.'
  );
}

type SizedImage = { '150x150'?: string; '480x480'?: string; '1000x1000'?: string };

function pickSizedImage(img?: SizedImage | string | null): string | null {
  if (!img) return null;
  if (typeof img === 'string') return img.trim() || null;
  return img['1000x1000'] || img['480x480'] || img['150x150'] || null;
}

export function getArtworkUrl(track: AudiusTrack): string | null {
  return (
    pickSizedImage(track.artwork) ||
    pickSizedImage(track.user?.profile_picture) ||
    null
  );
}
