import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { arweavePublicDataUrls } from '../lib/arweaveDataGateway';
import { resolveWayfinderDataUrls } from '../lib/wayfinder';

export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  artwork?: string;
  streamUrl?: string;
  duration?: number;
  isPermanent?: boolean;
  permaTxId?: string;
  assetId?: string;
}

function streamCandidatesForTrack(track: Track): string[] {
  const urls: string[] = [];
  const push = (url?: string | null) => {
    const value = String(url || '').trim();
    if (value && !urls.includes(value)) urls.push(value);
  };
  push(track.streamUrl);
  const txId = track.permaTxId || (track.isPermanent ? track.id : '');
  if (txId) {
    for (const url of arweavePublicDataUrls(txId)) push(url);
  }
  return urls;
}

async function streamCandidatesWithWayfinder(track: Track): Promise<string[]> {
  const txId = track.permaTxId || (track.isPermanent ? track.id : '');
  if (!txId) return streamCandidatesForTrack(track);
  try {
    const wayfinderUrls = await resolveWayfinderDataUrls(txId);
    const urls: string[] = [];
    const push = (url?: string | null) => {
      const value = String(url || '').trim();
      if (value && !urls.includes(value)) urls.push(value);
    };
    for (const url of wayfinderUrls) push(url);
    push(track.streamUrl);
    for (const url of arweavePublicDataUrls(txId)) push(url);
    return urls;
  } catch {
    return streamCandidatesForTrack(track);
  }
}

interface PlayerContextValue {
  currentTrack: Track | null;
  isPlaying: boolean;
  progress: number;
  play: (track: Track) => void;
  pause: () => void;
  toggle: () => void;
  seek: (value: number) => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const streamCandidatesRef = useRef<string[]>([]);
  const streamIndexRef = useRef(0);

  const startStreamAt = useCallback((index: number) => {
    const el = audioRef.current;
    const url = streamCandidatesRef.current[index];
    if (!el || !url) return;
    streamIndexRef.current = index;
    el.crossOrigin = 'anonymous';
    el.src = url;
    void el.play().catch(console.error);
  }, []);

  const play = useCallback(
    (track: Track) => {
      setCurrentTrack(track);
      setIsPlaying(true);
      // Start immediately on static candidates, then prefer Wayfinder when ready.
      const syncCandidates = streamCandidatesForTrack(track);
      streamCandidatesRef.current = syncCandidates;
      streamIndexRef.current = 0;
      if (syncCandidates.length === 0) return;
      if (!audioRef.current) audioRef.current = new Audio();
      startStreamAt(0);

      void streamCandidatesWithWayfinder(track).then((candidates) => {
        if (candidates.length === 0) return;
        streamCandidatesRef.current = candidates;
        // If still on the first static URL, switch to Wayfinder's best gateway.
        if (streamIndexRef.current === 0 && candidates[0] !== syncCandidates[0]) {
          startStreamAt(0);
        }
      });
    },
    [startStreamAt]
  );

  const pause = useCallback(() => {
    setIsPlaying(false);
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    if (!currentTrack) return;
    if (isPlaying) pause();
    else {
      const candidates = streamCandidatesForTrack(currentTrack);
      streamCandidatesRef.current = candidates;
      if (candidates.length === 0) return;
      if (!audioRef.current) audioRef.current = new Audio();
      startStreamAt(streamIndexRef.current);
      setIsPlaying(true);
    }
  }, [currentTrack, isPlaying, pause, startStreamAt]);

  const seek = useCallback((value: number) => {
    setProgress(value);
    if (audioRef.current && !isNaN(value)) {
      const t = (value / 100) * (audioRef.current.duration || 0);
      audioRef.current.currentTime = t;
    }
  }, []);

  React.useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTimeUpdate = () => {
      if (el.duration) setProgress((el.currentTime / el.duration) * 100);
    };
    const onEnded = () => setIsPlaying(false);
    const onError = () => {
      const next = streamIndexRef.current + 1;
      if (next < streamCandidatesRef.current.length) {
        startStreamAt(next);
        return;
      }
      setIsPlaying(false);
    };
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onError);
    return () => {
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onError);
    };
  }, [currentTrack?.id, startStreamAt]);

  return (
    <PlayerContext.Provider
      value={{ currentTrack, isPlaying, progress, play, pause, toggle, seek }}
    >
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be used within PlayerProvider');
  return ctx;
}
