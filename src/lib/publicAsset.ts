/**
 * URL for a file served from Vite `public/` (emitted at site root, respecting `base`).
 * Prefer this over hardcoded `/file.png` so assets resolve with `base: './'` and on subpaths.
 */
export function publicAsset(filename: string): string {
  const name = filename.replace(/^\//, '');
  const base = import.meta.env.BASE_URL || '/';
  if (base === '/') return `/${name}`;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return `${prefix}${name}`;
}
