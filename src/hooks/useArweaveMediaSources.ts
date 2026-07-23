import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ARWEAVE_MEDIA_SOURCE_TIMEOUT_MS, normalizeArweaveTxId } from '../lib/arweaveDataGateway';
import { resolveProfileMediaUrls } from '../lib/permaProfile';
import { resolveWayfinderDataUrls } from '../lib/wayfinder';

function extractTxId(raw: unknown): string | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  const normalized = normalizeArweaveTxId(value);
  if (normalized.length === 43) return normalized;
  const fromPath = value.match(/\/([A-Za-z0-9_-]{43})(?:$|[?#/])/);
  return fromPath?.[1] && fromPath[1].length === 43 ? fromPath[1] : null;
}

function mergeMediaSources(preferred: string[], fallback: string[]): string[] {
  const out: string[] = [];
  for (const url of [...preferred, ...fallback]) {
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * Ordered Arweave media URLs with `<img onError>` fallback cycling.
 * Starts with static gateways (arweave.net first), then merges Wayfinder winner when ready.
 * A load timeout advances past hanging gateways without dropping the rest of the list.
 */
export function useArweaveMediaSources(raw: unknown) {
  const staticSources = useMemo(() => resolveProfileMediaUrls(raw), [raw]);
  const [sources, setSources] = useState(staticSources);
  const [index, setIndex] = useState(0);
  const loadedRef = useRef(false);
  const sourcesRef = useRef(staticSources);
  sourcesRef.current = sources;

  const advanceSource = useCallback(() => {
    loadedRef.current = false;
    setIndex((current) => (current + 1 < sourcesRef.current.length ? current + 1 : current));
  }, []);

  useEffect(() => {
    loadedRef.current = false;
    setSources(staticSources);
    setIndex(0);

    const txId = extractTxId(raw);
    if (!txId) return;

    let cancelled = false;
    void resolveWayfinderDataUrls(txId).then((urls) => {
      if (cancelled || urls.length === 0) return;
      setSources((current) => {
        const merged = mergeMediaSources(urls, current.length > 0 ? current : staticSources);
        return merged.length > 0 ? merged : staticSources;
      });
      // Keep a working image if it already painted; otherwise restart from the winner.
      if (!loadedRef.current) setIndex(0);
    });

    return () => {
      cancelled = true;
    };
  }, [raw, staticSources]);

  useEffect(() => {
    const src = sources[index];
    if (!src || loadedRef.current) return;
    if (index >= sources.length - 1) return;

    const timer = setTimeout(() => {
      if (!loadedRef.current) advanceSource();
    }, ARWEAVE_MEDIA_SOURCE_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [sources, index, advanceSource]);

  const onLoad = useCallback(() => {
    loadedRef.current = true;
  }, []);

  const onError = useCallback(() => {
    advanceSource();
  }, [advanceSource]);

  return {
    src: sources[index] || null,
    sources,
    sourceIndex: index,
    onLoad,
    onError,
  };
}
