/**
 * Frontend beat generator: sequence "Your clips" (from permaweb profile / Arweave) + local files,
 * mix with Web Audio API, export WAV or use in Publish.
 */
import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { usePermaweb } from '../context/PermawebContext';
import { useGeneratedAudio } from '../context/GeneratedAudioContext';
import { arweaveTxDataUrl } from '../lib/arweaveDataGateway';
import { getSelectedOrLatestProfileByWallet } from '../lib/permaProfile';
import styles from './BeatGenerator.module.css';

type ClipSource = { id: string; title: string; url?: string; file?: File };

function decodeToBuffer(ctx: AudioContext, urlOrBuffer: string | ArrayBuffer): Promise<AudioBuffer> {
  if (typeof urlOrBuffer === 'string') {
    return fetch(urlOrBuffer).then((r) => r.arrayBuffer()).then((buf) => ctx.decodeAudioData(buf));
  }
  return ctx.decodeAudioData(urlOrBuffer);
}

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1;
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = buffer.length * blockAlign;
  const bufferLength = 44 + dataSize;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);
  let offset = 0;
  const write = (bytes: Uint8Array) => {
    bytes.forEach((b) => view.setUint8(offset++, b));
  };
  const writeStr = (s: string) => write(new TextEncoder().encode(s));
  writeStr('RIFF');
  view.setUint32(offset, bufferLength - 8, true); offset += 4;
  writeStr('WAVE');
  writeStr('fmt ');
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, format, true); offset += 2;
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * blockAlign, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, bitDepth, true); offset += 2;
  writeStr('data');
  view.setUint32(offset, dataSize, true); offset += 4;
  const left = buffer.getChannelData(0);
  const right = numChannels > 1 ? buffer.getChannelData(1) : left;
  for (let i = 0; i < buffer.length; i++) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, l < 0 ? l * 0x8000 : l * 0x7fff, true); offset += 2;
    view.setInt16(offset, r < 0 ? r * 0x8000 : r * 0x7fff, true); offset += 2;
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

export function BeatGenerator() {
  const navigate = useNavigate();
  const { address } = useWallet();
  const { libs } = usePermaweb();
  const { setGeneratedAudio } = useGeneratedAudio();
  const [clips, setClips] = useState<ClipSource[]>([]);
  const [loadingClips, setLoadingClips] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultBlob, setResultBlob] = useState<Blob | null>(null);

  useEffect(() => {
    if (!address || !libs) {
      setClips([]);
      return;
    }
    let cancelled = false;
    setLoadingClips(true);
    getSelectedOrLatestProfileByWallet(libs, address)
      .then((profile: any) => {
        if (cancelled) return;
        const raw = [
          ...(Array.isArray(profile?.arweaveTracks) ? profile.arweaveTracks : []),
          ...(Array.isArray(profile?.ArweaveTracks) ? profile.ArweaveTracks : []),
          ...(Array.isArray(profile?.samples) ? profile.samples : []),
          ...(Array.isArray(profile?.Samples) ? profile.Samples : []),
        ];
        const list = raw;
        const mapped: ClipSource[] = list
          .map((s: any, i: number) => ({
            id: s.txId || `clip-${i}`,
            title: s.title || `Clip ${i + 1}`,
            url: s.permawebUrl || (s.txId ? arweaveTxDataUrl(s.txId) : undefined),
          }))
          .filter((c: ClipSource) => c.url);
        const seen = new Set<string>();
        const next = mapped.filter((c) => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });
        setClips(next);
      })
      .catch(() => {
        if (!cancelled) setClips([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingClips(false);
      });
    return () => { cancelled = true; };
  }, [address, libs]);

  const addFile = useCallback((file: File) => {
    if (!file.type.startsWith('audio/')) return;
    setClips((prev) => [...prev, { id: `file-${Date.now()}`, title: file.name, file }]);
  }, []);

  const removeClip = useCallback((id: string) => {
    setClips((prev) => prev.filter((c) => c.id !== id));
    setResultBlob(null);
  }, []);

  const moveClip = useCallback((index: number, dir: 1 | -1) => {
    const next = index + dir;
    if (next < 0 || next >= clips.length) return;
    setClips((prev) => {
      const arr = [...prev];
      [arr[index], arr[next]] = [arr[next], arr[index]];
      return arr;
    });
    setResultBlob(null);
  }, [clips.length]);

  const generate = useCallback(async () => {
    if (clips.length === 0) {
      setError('Add at least one clip (from your profile or upload).');
      return;
    }
    setGenerating(true);
    setError(null);
    setResultBlob(null);
    const ctx = new AudioContext();
    try {
      const buffers: AudioBuffer[] = [];
      for (const clip of clips) {
        let buf: ArrayBuffer;
        if (clip.file) {
          buf = await clip.file.arrayBuffer();
        } else if (clip.url) {
          const res = await fetch(clip.url, { mode: 'cors' });
          if (!res.ok) throw new Error(`Failed to load ${clip.title}`);
          buf = await res.arrayBuffer();
        } else continue;
        const decoded = await decodeToBuffer(ctx, buf);
        buffers.push(decoded);
      }
      if (buffers.length === 0) throw new Error('No valid audio decoded.');
      const sampleRate = buffers[0].sampleRate;
      const numChannels = Math.max(1, buffers[0].numberOfChannels);
      const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
      const offline = new OfflineAudioContext(numChannels, totalLength, sampleRate);
      let offsetSamples = 0;
      for (const buf of buffers) {
        const bufferSource = offline.createBufferSource();
        bufferSource.buffer = buf;
        bufferSource.connect(offline.destination);
        bufferSource.start(offsetSamples / sampleRate);
        bufferSource.stop(offsetSamples / sampleRate + buf.duration);
        offsetSamples += buf.length;
      }
      const rendered = await offline.startRendering();
      const wav = audioBufferToWav(rendered);
      setResultBlob(wav);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to generate beat.');
    } finally {
      setGenerating(false);
    }
  }, [clips]);

  const useInPublish = useCallback(() => {
    if (resultBlob) {
      setGeneratedAudio(resultBlob);
      navigate('/');
    }
  }, [resultBlob, setGeneratedAudio, navigate]);

  const download = useCallback(() => {
    if (!resultBlob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(resultBlob);
    a.download = 'streamvault-beat.wav';
    a.click();
    URL.revokeObjectURL(a.href);
  }, [resultBlob]);

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Beat / instrumental generator</h2>
      <p className={styles.text}>
        Use your Arweave clips (samples stored with your profile) and optional local files. Order the clips, then generate one mixed track. Use in Publish or download.
      </p>
      {!address && (
        <p className={styles.hint}>Connect a wallet and create a permaweb profile to see your published samples here.</p>
      )}
      {address && loadingClips && <p className={styles.hint}>Loading your clips…</p>}
      <div className={styles.clipList}>
        {clips.map((clip, i) => (
          <div key={clip.id} className={styles.clipRow}>
            <span className={styles.clipOrder}>{i + 1}</span>
            <span className={styles.clipTitle}>{clip.title}</span>
            <div className={styles.clipActions}>
              <button type="button" className={styles.smallBtn} onClick={() => moveClip(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" className={styles.smallBtn} onClick={() => moveClip(i, 1)} disabled={i === clips.length - 1}>↓</button>
              <button type="button" className={styles.smallBtn} onClick={() => removeClip(clip.id)}>✕</button>
            </div>
          </div>
        ))}
      </div>
      <label className={styles.fileLabel}>
        Add local audio
        <input type="file" accept="audio/*" onChange={(e) => e.target.files?.[0] && addFile(e.target.files[0])} />
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.primaryBtn} onClick={generate} disabled={generating || clips.length === 0}>
          {generating ? 'Generating…' : 'Generate beat'}
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {resultBlob && (
        <div className={styles.result}>
          <p className={styles.resultLabel}>Ready</p>
          <button type="button" className={styles.primaryBtn} onClick={useInPublish}>Use in Publish →</button>
          <button type="button" className={styles.secondaryBtn} onClick={download}>Download WAV</button>
        </div>
      )}
    </section>
  );
}
