import styles from './Vault.module.css';

interface VaultPlaceholderProps {
  title: string;
  message?: string;
}

export function VaultPlaceholder({ title, message = 'Coming soon.' }: VaultPlaceholderProps) {
  return (
    <>
      <h1 className={styles.sectionTitle}>{title}</h1>
      <p className={styles.placeholderBox}>{message}</p>
    </>
  );
}
