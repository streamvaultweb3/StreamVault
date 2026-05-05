import { useRef } from 'react';
import styles from '../PublishModal.module.css';

type Props = {
  fullFile: File | null;
  onFileChange: (file: File | null) => void;
  hasGeneratedAudio: boolean;
  onClearGeneratedAudio: () => void;
  disabled?: boolean;
};

export function PublishPrimaryUpload({
  fullFile,
  onFileChange,
  hasGeneratedAudio,
  onClearGeneratedAudio,
  disabled,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const displayName = fullFile?.name ?? (hasGeneratedAudio ? 'Generated beat (Creator tools)' : null);

  return (
    <div className={styles.primaryUploadWrap}>
      <input
        ref={inputRef}
        className={styles.primaryUploadInput}
        type="file"
        accept="audio/*"
        disabled={disabled}
        onChange={(e) => onFileChange(e.target.files?.[0] || null)}
      />
      <button
        type="button"
        className={styles.primaryUploadBtn}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {displayName ? 'Change audio file' : 'Choose audio file'}
      </button>
      {displayName && (
        <p className={styles.primaryUploadFileName} title={displayName}>
          {displayName}
        </p>
      )}
      {!fullFile && hasGeneratedAudio && (
        <p className={styles.generatedCoverNote}>
          Using generated beat from Creator tools.{' '}
          <button type="button" className={styles.clearGeneratedBtn} onClick={onClearGeneratedAudio}>
            Clear
          </button>
        </p>
      )}
    </div>
  );
}
