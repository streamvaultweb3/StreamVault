import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LogoSpinner } from '../components/LogoSpinner';
import type { Track } from '../context/PlayerContext';
import { usePlayer } from '../context/PlayerContext';
import { arweaveTxDataUrl, arweaveTxMetaUrl } from '../lib/arweaveDataGateway';
import {
  artworkUrlFromTags,
  explorerTransactionRows,
  fetchArweaveTxExplorer,
  isAudioContentType,
  mergeArweaveTags,
  parseTrackTagSections,
  trackStreamUrl,
  uploadRecordToArweaveTags,
  type ArweaveTag,
  type ArweaveTxExplorerData,
  type TxFieldRow,
} from '../lib/arweaveTxDetail';
import { arweaveArtistPath, looksLikeWalletAddress } from '../lib/arweaveArtist';
import { portalHyperbeamAssetUrl } from '../lib/aoNode';
import { findUploadLedgerByTxId } from '../lib/uploadLedger';
import { findAtomicAssetIdForAudioTx, fetchAtomicAssetMap, fetchAtomicAssetDisplayMetadata, type AtomicAssetDisplayMetadata } from '../lib/arweaveDiscovery';
import { uploadedTrackToPlayerTrack } from '../lib/uploadedTracks';
import { ListOnUcm } from '../components/ListOnUcm';
import styles from './TrackDetail.module.css';

function FieldRow({ row }: { row: TxFieldRow }) {
  return (
    <div className={styles.fieldRow}>
      <span className={styles.fieldLabel}>{row.label}</span>
      <span className={row.mono ? `${styles.fieldValue} ${styles.fieldValueMono}` : styles.fieldValue}>
        {row.href ? (
          row.href.startsWith('/') ? (
            <Link to={row.href}>{row.value}</Link>
          ) : (
            <a href={row.href} target="_blank" rel="noopener noreferrer">
              {row.value}
            </a>
          )
        ) : (
          row.value
        )}
      </span>
    </div>
  );
}

function TagSection({ title, rows }: { title: string; rows: TxFieldRow[] }) {
  if (!rows.length) return null;
  return (
    <section className={styles.section + ' glass'}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <div className={styles.fieldGrid}>
        {rows.map((row) => (
          <FieldRow key={`${title}-${row.label}`} row={row} />
        ))}
      </div>
    </section>
  );
}

function OtherTagsTable({ tags }: { tags: ArweaveTag[] }) {
  if (!tags.length) return null;
  return (
    <section className={styles.section + ' glass'}>
      <h2 className={styles.sectionTitle}>Other tags</h2>
      <table className={styles.tagTable}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {tags.map((t) => (
            <tr key={t.name}>
              <td className={styles.tagName}>{t.name}</td>
              <td>{t.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function TrackDetail() {
  const { txId: rawTxId } = useParams<{ txId: string }>();
  const { play, pause, currentTrack, isPlaying } = usePlayer();
  const [data, setData] = useState<ArweaveTxExplorerData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rawTxId?.trim()) {
      setError('Missing transaction id.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchArweaveTxExplorer(rawTxId);
        if (!cancelled) setData(result);
      } catch (e) {
        if (!cancelled) {
          setData(null);
          setError((e as Error)?.message || 'Failed to load transaction.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rawTxId]);

  const ledgerTrack = useMemo(() => {
    const lookupId = data?.audioTxId || data?.txId;
    if (!lookupId) return null;
    return findUploadLedgerByTxId(lookupId);
  }, [data?.audioTxId, data?.txId]);

  const onChainTags = data?.transaction?.tags ?? [];
  const tags = useMemo(
    () =>
      mergeArweaveTags(
        onChainTags,
        ledgerTrack ? uploadRecordToArweaveTags(ledgerTrack) : undefined
      ),
    [onChainTags, ledgerTrack]
  );
  const sections = useMemo(() => parseTrackTagSections(tags), [tags]);
  const txRows = useMemo(() => (data ? explorerTransactionRows(data) : []), [data]);

  const [resolvedAssetId, setResolvedAssetId] = useState<string | null>(null);
  const [assetMetadataFallback, setAssetMetadataFallback] = useState<AtomicAssetDisplayMetadata | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!data?.txId) {
        setResolvedAssetId(null);
        return;
      }

      if (data.processId) {
        if (!cancelled) setResolvedAssetId(data.processId);
        return;
      }

      const tagValue = (name: string) => tags.find((t) => t.name === name)?.value?.trim() || '';

      const fromTrackIdTag = tagValue('Track-Id');
      if (fromTrackIdTag) {
        if (!cancelled) setResolvedAssetId(fromTrackIdTag);
        return;
      }

      const fromLedger = ledgerTrack?.assetId || null;
      if (fromLedger) {
        if (!cancelled) setResolvedAssetId(fromLedger);
        return;
      }

      const audioLookupId = data.audioTxId || data.txId;
      const fromGraph = await findAtomicAssetIdForAudioTx(audioLookupId);
      if (fromGraph) {
        if (!cancelled) setResolvedAssetId(fromGraph);
        return;
      }

      const fromMap = (await fetchAtomicAssetMap({ limit: 100 })).get(audioLookupId) || null;
      if (!cancelled) setResolvedAssetId(fromMap);
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.txId, data?.processId, data?.audioTxId, tags, ledgerTrack?.assetId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!resolvedAssetId) {
        setAssetMetadataFallback(null);
        return;
      }

      const hasIdentityTags = Boolean(
        tags.find((t) => t.name === 'Title')?.value ||
          tags.find((t) => t.name === 'Artist')?.value ||
          artworkUrlFromTags(tags)
      );
      const hasLedgerMeta = Boolean(
        ledgerTrack?.title || ledgerTrack?.artist || ledgerTrack?.artworkTxId || ledgerTrack?.artworkUrl
      );
      if (hasIdentityTags || hasLedgerMeta) {
        setAssetMetadataFallback(null);
        return;
      }

      const meta = await fetchAtomicAssetDisplayMetadata(resolvedAssetId);
      if (!cancelled) setAssetMetadataFallback(meta);
    })();
    return () => {
      cancelled = true;
    };
  }, [resolvedAssetId, tags, ledgerTrack?.title, ledgerTrack?.artist, ledgerTrack?.artworkTxId, ledgerTrack?.artworkUrl]);

  const title =
    sections.identity.find((r) => r.label === 'Title')?.value ||
    ledgerTrack?.title ||
    assetMetadataFallback?.title ||
    'Untitled';
  const artist =
    sections.identity.find((r) => r.label === 'Artist')?.value ||
    ledgerTrack?.artist ||
    assetMetadataFallback?.artist ||
    'Unknown artist';
  const creator =
    sections.identity.find((r) => r.label === 'Creator')?.value ||
    data?.transaction?.owner ||
    ledgerTrack?.walletAddress ||
    assetMetadataFallback?.creator;
  const contentType =
    tags.find((t) => t.name === 'Content-Type')?.value || ledgerTrack?.contentType;
  const isAudio = isAudioContentType(contentType);
  const coverUrl =
    artworkUrlFromTags(tags) ||
    (ledgerTrack?.artworkTxId ? arweaveTxDataUrl(ledgerTrack.artworkTxId) : ledgerTrack?.artworkUrl) ||
    assetMetadataFallback?.artworkUrl;

  const playerTrack: Track | null = useMemo(() => {
    const streamTxId = data?.audioTxId || data?.txId;
    if (!streamTxId) return null;
    if (ledgerTrack) return uploadedTrackToPlayerTrack(ledgerTrack);
    if (!isAudio) return null;
    return {
      id: streamTxId,
      title,
      artist,
      artistId: creator || streamTxId,
      artwork: coverUrl,
      streamUrl: trackStreamUrl(streamTxId, tags, true),
      isPermanent: true,
      permaTxId: streamTxId,
      assetId: resolvedAssetId || undefined,
    };
  }, [data?.audioTxId, data?.txId, ledgerTrack, isAudio, title, artist, creator, tags, coverUrl, resolvedAssetId]);

  const atomicRows: TxFieldRow[] = useMemo(() => {
    const rows = [...sections.atomic];
    if (resolvedAssetId && !rows.some((r) => r.value === resolvedAssetId)) {
      rows.unshift({
        label: 'Process ID',
        value: resolvedAssetId,
        mono: true,
        href: portalHyperbeamAssetUrl(resolvedAssetId),
      });
    }
    return rows;
  }, [sections.atomic, resolvedAssetId]);

  const isCurrent = playerTrack && currentTrack?.id === playerTrack.id;

  const handlePlay = () => {
    if (!playerTrack) return;
    if (isCurrent && isPlaying) pause();
    else play(playerTrack);
  };

  if (loading) return <LogoSpinner />;
  if (error) return <p className={styles.error}>{error}</p>;
  if (!data) return <p className={styles.error}>Transaction not found.</p>;

  const description = sections.identity.find((r) => r.label === 'Description')?.value;

  const creatorHref =
    creator && looksLikeWalletAddress(creator)
      ? arweaveArtistPath(creator)
      : creator
        ? `/profile/${creator}`
        : undefined;

  return (
    <div className={styles.page}>
      <Link to="/" className={styles.backLink}>
        ← Back
      </Link>

      {data.warnings.map((w) => (
        <p key={w} className={styles.warning}>
          {w}
        </p>
      ))}

      <header className={styles.hero + ' glass'}>
        <div className={styles.coverWrap}>
          {coverUrl ? (
            <img src={coverUrl} alt="" className={styles.cover} loading="lazy" />
          ) : (
            <div className={styles.coverPlaceholder} aria-hidden="true" />
          )}
          {playerTrack && (
            <button type="button" className={styles.playBtn} onClick={handlePlay} aria-label="Play track">
              <span className={styles.playIcon} />
            </button>
          )}
        </div>
        <div className={styles.heroBody}>
          <h1 className={styles.title}>{title}</h1>
          <p className={styles.artist}>
            {creatorHref && creator && creator !== artist ? (
              <>
                <Link to={creatorHref}>{artist}</Link>
                {' · '}
                <Link to={creatorHref} className={styles.creatorMono}>
                  {creator.slice(0, 12)}…
                </Link>
              </>
            ) : creatorHref ? (
              <Link to={creatorHref}>{artist}</Link>
            ) : (
              artist
            )}
          </p>
          <div className={styles.badges}>
            {isAudio && <span className={styles.badge}>Audio</span>}
            {resolvedAssetId && <span className={styles.badge}>Atomic Asset</span>}
            {data.graphqlFallback && <span className={styles.badge}>GraphQL metadata</span>}
            {assetMetadataFallback && <span className={styles.badge}>HB metadata</span>}
            {data.status?.confirmed && <span className={styles.badge}>Confirmed</span>}
            {contentType && <span className={styles.badge}>{contentType}</span>}
          </div>
          <div className={styles.actions}>
            {playerTrack && (
              <button type="button" className={styles.actionBtn} onClick={handlePlay}>
                {isCurrent && isPlaying ? 'Pause' : 'Play'}
              </button>
            )}
            <a
              className={styles.actionLinkAccent}
              href={arweaveTxMetaUrl(data.txId)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Arweave explorer
            </a>
            {isAudio && playerTrack?.streamUrl && (
              <a className={styles.actionLink} href={playerTrack.streamUrl} target="_blank" rel="noopener noreferrer">
                Open data
              </a>
            )}
          </div>
          {description && <p className={styles.subtext}>{description}</p>}
        </div>
      </header>

      {resolvedAssetId ? (
        <section className={styles.section + ' glass'}>
          <ListOnUcm assetId={resolvedAssetId} title={title} compact />
        </section>
      ) : null}

      <section className={styles.section + ' glass'}>
        <h2 className={styles.sectionTitle}>Transaction</h2>
        <div className={styles.fieldGrid}>
          {txRows.map((row) => (
            <FieldRow key={row.label} row={row} />
          ))}
        </div>
      </section>

      <TagSection title="Identity" rows={sections.identity.filter((r) => r.label !== 'Description')} />
      <TagSection title="Media" rows={sections.media} />
      <TagSection title="App" rows={sections.app} />
      <TagSection title="License / UDL" rows={sections.license} />
      <TagSection title="Royalties" rows={sections.royalties} />
      <TagSection title="Atomic asset" rows={atomicRows} />
      <TagSection title="Audius" rows={sections.audius} />
      <OtherTagsTable tags={sections.other} />

      {!data.transaction?.tags?.length && (
        <p className={styles.subtext}>No tags were returned for this id.</p>
      )}
    </div>
  );
}
