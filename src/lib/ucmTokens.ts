/**
 * UCM quote tokens (Bazar-compatible). Listings settle in AO tokens — not L1 AR.
 * @see https://github.com/permaweb/bazar — AssetActionMarketOrders + TOKEN_REGISTRY
 */
/** Mainnet wAR — Bazar default quote token. */
export const DEFAULT_WAR_TOKEN_ID =
  (import.meta.env.VITE_AO_WAR_TOKEN as string | undefined)?.trim() ||
  'xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10';

export type UcmQuoteToken = {
  id: string;
  name: string;
  symbol: string;
  denomination: number;
  description?: string;
  priority: number;
};

/** Bazar-aligned AO tokens commonly used as UCM quote side. */
const BAZAR_QUOTE_TOKENS: UcmQuoteToken[] = [
  {
    id: DEFAULT_WAR_TOKEN_ID,
    name: 'Wrapped AR',
    symbol: 'wAR',
    denomination: 12,
    description: 'Wrapped Arweave (Bazar default market token)',
    priority: 1,
  },
  {
    id: '4hXj_E-5fAKmo4E8KjgQvuDJKAFk9P2grhycVmISDLs',
    name: 'PI Token',
    symbol: 'PI',
    denomination: 12,
    description: 'Permaweb Index',
    priority: 2,
  },
  {
    id: '0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc',
    name: 'AO',
    symbol: 'AO',
    denomination: 12,
    priority: 3,
  },
  {
    id: 'DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo',
    name: 'PIXL Token',
    symbol: 'PIXL',
    denomination: 6,
    priority: 4,
  },
  {
    id: 'FBt9A5GA_KXMMSxA2DJ0xZbAq8sLLU2ak-YJe9zDvg8',
    name: 'USDA',
    symbol: 'USDA',
    denomination: 12,
    priority: 5,
  },
  {
    id: '7GoQfmSOct_aUOWKM4xbKGg6DzAmOgdKwg8Kf-CbHm4',
    name: 'Wander',
    symbol: 'WNDR',
    denomination: 18,
    priority: 6,
  },
];

function parseEnvQuoteTokenIds(): string[] | null {
  const raw = (import.meta.env.VITE_UCM_QUOTE_TOKEN_IDS as string | undefined)?.trim();
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length ? ids : null;
}

export function getUcmQuoteTokens(): UcmQuoteToken[] {
  const byId = new Map<string, UcmQuoteToken>();
  for (const token of BAZAR_QUOTE_TOKENS) byId.set(token.id, token);

  const allowList = parseEnvQuoteTokenIds();
  const list = allowList
    ? allowList.map((id) => byId.get(id)).filter(Boolean) as UcmQuoteToken[]
    : Array.from(byId.values());

  return list.sort((a, b) => a.priority - b.priority);
}

export function getUcmQuoteToken(tokenId: string | null | undefined): UcmQuoteToken | null {
  const id = String(tokenId || '').trim();
  if (!id) return null;
  return getUcmQuoteTokens().find((token) => token.id === id) || null;
}

export function getDefaultUcmQuoteToken(): UcmQuoteToken {
  return getUcmQuoteToken(DEFAULT_WAR_TOKEN_ID) || getUcmQuoteTokens()[0];
}

/** Convert human amount (e.g. 0.1 wAR) to token base units for UCM unitPrice. */
export function tokenDisplayToBaseUnits(amount: string | number | undefined, denomination: number): string {
  const raw = String(amount ?? '0').trim();
  if (!raw || raw === '0') return '0';
  const denom = Math.max(0, Math.floor(denomination || 0));
  const factor = denom > 0 ? 10n ** BigInt(denom) : 1n;
  const [whole, frac = ''] = raw.split('.');
  const padded = denom > 0 ? (frac + '0'.repeat(denom)).slice(0, denom) : '';
  try {
    if (denom === 0) return BigInt(whole || '0').toString();
    return (BigInt(whole || '0') * factor + BigInt(padded || '0')).toString();
  } catch {
    return '0';
  }
}

/** Convert token base units from orderbook to display amount. */
export function tokenBaseUnitsToDisplay(baseUnits: string | undefined, denomination: number): string {
  if (!baseUnits || baseUnits === '0') return '0';
  const denom = Math.max(0, Math.floor(denomination || 0));
  try {
    const raw = BigInt(baseUnits);
    if (denom <= 0) return raw.toString();
    const factor = 10n ** BigInt(denom);
    const whole = raw / factor;
    const frac = raw % factor;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(denom, '0').replace(/0+$/, '');
    return `${whole}.${fracStr}`;
  } catch {
    return '0';
  }
}
