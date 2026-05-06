import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSpotifyAuth } from '../context/SpotifyAuthContext';
import styles from './Home.module.css';

export function SpotifyCallback() {
  const navigate = useNavigate();
  const { completeFromRedirect, restartConnect } = useSpotifyAuth();
  const [message, setMessage] = useState('Completing Spotify connection…');
  const [canRestart, setCanRestart] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await completeFromRedirect();
        if (!cancelled) navigate('/', { replace: true });
      } catch (e: any) {
        if (!cancelled) {
          setMessage(String(e?.message || 'Spotify connection failed.'));
          setCanRestart(e?.code === 'SPOTIFY_STATE_MISMATCH');
          // keep user on callback route so message is visible
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [completeFromRedirect, navigate]);

  return (
    <div className={styles.page}>
      <section className={styles.audiusSection} style={{ marginTop: '32px' }}>
        <h2 className={styles.sectionTitle}>Spotify</h2>
        <p className={styles.sectionSubtitle}>{message}</p>
        <div style={{ marginTop: '14px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {canRestart ? (
            <button
              className={styles.ctaBtn}
              onClick={() => {
                setMessage('Restarting Spotify connect…');
                setCanRestart(false);
                restartConnect();
              }}
            >
              Restart Spotify connect
            </button>
          ) : null}
          <button className={styles.experimentalBtn} onClick={() => navigate('/', { replace: true })}>
            Back to home
          </button>
        </div>
      </section>
    </div>
  );
}

