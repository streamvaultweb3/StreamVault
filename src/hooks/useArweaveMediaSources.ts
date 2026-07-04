import { useCallback, useEffect, useMemo, useState } from 'react';
import { normalizeArweaveTxId } from '../lib/arweaveDataGateway';
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

/**
 * Ordered Arweave media URLs with `<img onError>` fallback cycling.
 * Starts with static gateways (fast paint), then prepends Wayfinder winner when ready.
 */
export function useArweaveMediaSources(raw: unknown) {
  const staticSources = useMemo(() => resolveProfileMediaUrls(raw), [raw]);
  const [sources, setSources] = useState(staticSources);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setSources(staticSources);
    setIndex(0);

    const txId = extractTxId(raw);
    if (!txId) return;

    let cancelled = false;
    void resolveWayfinderDataUrls(txId).then((urls) => {
      if (cancelled || urls.length === 0) return;
      setSources(urls);
      setIndex(0);
    });

    return () => {
      cancelled = true;
    };
  }, [raw]);

  const onError = useCallback(() => {
    setIndex((current) => current + 1);
  }, []);

  return {
    src: sources[index] || null,
    sources,
    sourceIndex: index,
    onError,
  };
}
