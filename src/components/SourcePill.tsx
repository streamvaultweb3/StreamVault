import { trackBadgeTone } from '../lib/trackBadges';
import styles from './SourcePill.module.css';

type SourcePillProps = {
  label: string;
  className?: string;
  title?: string;
};

export function SourcePill({ label, className, title }: SourcePillProps) {
  const tone = trackBadgeTone(label);
  const toneClass =
    tone === 'atomic' ? styles.atomic : tone === 'permanent' ? styles.permanent : styles.default;

  return (
    <span className={[styles.pill, toneClass, className].filter(Boolean).join(' ')} title={title}>
      {label}
    </span>
  );
}
