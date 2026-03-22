import { useEffect, useMemo, useState } from 'react';
import styles from '../pages/Profile.module.css';

export function CreateProfileModal(props: {
  mode?: 'create' | 'edit';
  creating: boolean;
  onClose: () => void;
  initialUsername?: string;
  initialDisplayName?: string;
  initialDescription?: string;
  initialAvatarUrl?: string | null;
  initialBannerUrl?: string | null;
  initialThumbnailValue?: string | null;
  initialBannerValue?: string | null;
  onCreate: (form: {
    username: string;
    displayName: string;
    description: string;
    thumbnail?: File | null;
    banner?: File | null;
    thumbnailValue?: string | null;
    bannerValue?: string | null;
    removeThumbnail?: boolean;
    removeBanner?: boolean;
  }) => void;
}) {
  const mode = props.mode || 'create';
  const [username, setUsername] = useState(props.initialUsername || '');
  const [displayName, setDisplayName] = useState(props.initialDisplayName || '');
  const [description, setDescription] = useState(props.initialDescription || '');
  const [thumbnail, setThumbnail] = useState<File | null>(null);
  const [banner, setBanner] = useState<File | null>(null);
  const [removeThumbnail, setRemoveThumbnail] = useState(false);
  const [removeBanner, setRemoveBanner] = useState(false);

  const avatarPreview = useMemo(
    () => (thumbnail ? URL.createObjectURL(thumbnail) : props.initialAvatarUrl || null),
    [thumbnail, props.initialAvatarUrl]
  );
  const bannerPreview = useMemo(
    () => (banner ? URL.createObjectURL(banner) : props.initialBannerUrl || null),
    [banner, props.initialBannerUrl]
  );

  useEffect(() => {
    return () => {
      if (avatarPreview && avatarPreview.startsWith('blob:')) URL.revokeObjectURL(avatarPreview);
      if (bannerPreview && bannerPreview.startsWith('blob:')) URL.revokeObjectURL(bannerPreview);
    };
  }, [avatarPreview, bannerPreview]);

  return (
    <div className={styles.modalOverlay} onClick={props.onClose}>
      <div className={styles.modal + ' glass-strong'} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3>{mode === 'edit' ? 'Edit permaweb profile' : 'Create permaweb profile'}</h3>
          <button type="button" className={styles.modalClose} onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className={styles.subtext}>
          {mode === 'edit'
            ? 'Update your profile details with permaweb-libs. Indexing can take a moment.'
            : 'This creates a permanent identity using permaweb-libs. Indexing can take a moment.'}
        </p>

        <div className={styles.form}>
          {mode === 'edit' && (
            <div className={styles.profileMediaCard}>
              <div className={styles.profileBannerPreviewWrap}>
                {bannerPreview ? (
                  <img className={styles.profileBannerPreview} src={bannerPreview} alt="" />
                ) : (
                  <div className={styles.profileBannerPreviewPlaceholder} />
                )}
                {avatarPreview ? (
                  <img className={styles.profileAvatarPreview} src={avatarPreview} alt="" />
                ) : (
                  <div className={styles.profileAvatarPreviewPlaceholder} />
                )}
              </div>
              <div className={styles.profileMediaActions}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => {
                    setThumbnail(null);
                    setRemoveThumbnail(true);
                  }}
                >
                  Remove Avatar
                </button>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => {
                    setBanner(null);
                    setRemoveBanner(true);
                  }}
                >
                  Remove Banner
                </button>
              </div>
            </div>
          )}
          <label className={styles.label}>
            Handle
            <input className={styles.input} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="streamvault" />
          </label>
          <label className={styles.label}>
            Name
            <input className={styles.input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="StreamVault Artist" />
          </label>
          <label className={styles.label}>
            Bio
            <textarea className={styles.textarea} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Creator-first. Permanent by design." />
          </label>
          <div className={styles.fileRow}>
            <label className={styles.file}>
              Avatar
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  setThumbnail(e.target.files?.[0] || null);
                  if (e.target.files?.[0]) setRemoveThumbnail(false);
                }}
              />
            </label>
            <label className={styles.file}>
              Banner
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  setBanner(e.target.files?.[0] || null);
                  if (e.target.files?.[0]) setRemoveBanner(false);
                }}
              />
            </label>
          </div>
        </div>

        <div className={styles.modalActions}>
          <button type="button" className={styles.secondaryBtn} onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={props.creating || !username.trim() || !displayName.trim()}
            onClick={() =>
              props.onCreate({
                username,
                displayName,
                description,
                thumbnail,
                banner,
                thumbnailValue: !removeThumbnail && !thumbnail ? props.initialThumbnailValue || null : null,
                bannerValue: !removeBanner && !banner ? props.initialBannerValue || null : null,
                removeThumbnail,
                removeBanner,
              })
            }
          >
            {props.creating ? (mode === 'edit' ? 'Saving…' : 'Creating…') : mode === 'edit' ? 'Save changes' : 'Create profile'}
          </button>
        </div>
      </div>
    </div>
  );
}
