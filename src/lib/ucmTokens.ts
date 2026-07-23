/**
 * UCM quote tokens (Bazar-compatible). Listings settle in AO tokens — not L1 AR.
 * Mirrors Bazar `TOKEN_REGISTRY` / `TokenSelector` so StreamVault can list against the same markets.
 * @see https://github.com/permaweb/bazar — helpers/config.ts TOKEN_REGISTRY
 */

/** Mainnet wAR — common Bazar market token (StreamVault listing default). */
export const DEFAULT_WAR_TOKEN_ID =
  (import.meta.env.VITE_AO_WAR_TOKEN as string | undefined)?.trim() ||
  'xU9zFkq3X2ZQ6olwNVvr1vUWIjc3kXTWr7xKQD6dh10';

const PREFERRED_QUOTE_TOKEN_KEY = 'streamvault:ucm-quote-token';

export type UcmQuoteToken = {
  id: string;
  name: string;
  symbol: string;
  denomination: number;
  description?: string;
  /** Optional Arweave tx id for token logo (Bazar TOKEN_REGISTRY). */
  logo?: string;
  priority: number;
};

/** Bazar-aligned AO tokens used as the UCM quote / "swap for" side. */
const BAZAR_QUOTE_TOKENS: UcmQuoteToken[] = [
  {
    id: DEFAULT_WAR_TOKEN_ID,
    name: 'Wrapped AR',
    symbol: 'wAR',
    denomination: 12,
    description: 'Wrapped Arweave',
    logo: 'L99jaxRKQKJt9CqoJtPaieGPEhJD3wNhR4iGqc8amXs',
    priority: 1,
  },
  {
    id: '4hXj_E-5fAKmo4E8KjgQvuDJKAFk9P2grhycVmISDLs',
    name: 'PI Token',
    symbol: 'PI',
    denomination: 12,
    description: 'Permaweb Index',
    logo: 'zmQwyD6QiZge10OG2HasBqu27Zg0znGkdFRufOq6rv0',
    priority: 2,
  },
  {
    id: '0syT13r0s0tgPmIed95bJnuSqaD29HQNN8D3ElLSrsc',
    name: 'AO',
    symbol: 'AO',
    denomination: 12,
    logo: 'UkS-mdoiG8hcAClhKK8ch4ZhEzla0mCPDOix9hpdSFE',
    priority: 3,
  },
  {
    id: 'FBt9A5GA_KXMMSxA2DJ0xZbAq8sLLU2ak-YJe9zDvg8',
    name: 'USDA',
    symbol: 'USDA',
    denomination: 12,
    description: 'USDA stablecoin',
    logo: 'seXozJrsP0OgI0gvAnr8zmfxiHHb5iSlI9wMI8SdamE',
    priority: 4,
  },
  {
    id: 'DM3FoZUq_yebASPhgd8pEIRIzDW6muXEhxz5-JwbZwo',
    name: 'PIXL Token',
    symbol: 'PIXL',
    denomination: 6,
    logo: 'czR2tJmSr7upPpReXu6IuOc2H7RuHRRAhI7DXAUlszU',
    priority: 5,
  },
  {
    id: '7GoQfmSOct_aUOWKM4xbKGg6DzAmOgdKwg8Kf-CbHm4',
    name: 'Wander',
    symbol: 'WNDR',
    denomination: 18,
    logo: 'xUO2tQglSYsW89aLYN8ErGivZqezoDaEn95JniaCBZk',
    priority: 6,
  },
  {
    id: 'qNvAoz0TgcH7DMg8BCVn8jF32QH5L6T29VjHxhHqqGE',
    name: 'ARIO',
    symbol: 'ARIO',
    denomination: 6,
    logo: 'GIayVyo49wof1hOtgLcJ_XAE6OuF5MeYiYsgu3z4gxk',
    priority: 7,
  },
  {
    id: 'mqBYxpDsolZmJyBdTK8TJp_ftOuIUXVYcSQ8MYZdJg0',
    name: 'Apus.Network',
    symbol: 'APUS',
    denomination: 12,
    logo: 'sixqgAh5MEevkhwH4JuCYwmumaYMTOBi3N5_N1GQ6Uc',
    priority: 8,
  },
  {
    id: 's6jcB3ctSbiDNwR-paJgy5iOAhahXahLul8exSLHbGE',
    name: 'Game Token',
    symbol: 'GAME',
    denomination: 18,
    logo: '-c4VdpgmfuS4YadtLuxVZzTd2DQ3ipodA6cz8pwjn20',
    priority: 9,
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
    ? (allowList.map((id) => byId.get(id)).filter(Boolean) as UcmQuoteToken[])
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

/** Last market token chosen in List on UCM (survives reloads). */
export function readPreferredUcmQuoteTokenId(): string | null {
  try {
    const id = localStorage.getItem(PREFERRED_QUOTE_TOKEN_KEY);
    return id && getUcmQuoteToken(id) ? id : null;
  } catch {
    return null;
  }
}

export function rememberPreferredUcmQuoteTokenId(tokenId: string): void {
  const id = String(tokenId || '').trim();
  if (!id || !getUcmQuoteToken(id)) return;
  try {
    localStorage.setItem(PREFERRED_QUOTE_TOKEN_KEY, id);
  } catch {
    // ignore quota / private mode
  }
}

export function resolveInitialUcmQuoteToken(): UcmQuoteToken {
  const preferred = readPreferredUcmQuoteTokenId();
  return (preferred && getUcmQuoteToken(preferred)) || getDefaultUcmQuoteToken();
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
