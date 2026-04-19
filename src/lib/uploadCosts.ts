import { arweaveDataGatewayHost } from './arweaveDataGateway';

const WINSTON_PER_AR = 1_000_000_000_000;

export type UploadCostEstimate = {
  turboWinc?: number;
  l1Winston?: number;
};

function parseNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function formatArFromWinston(value: number): string {
  return `${(value / WINSTON_PER_AR).toFixed(6)} AR`;
}

export async function fetchTurboCostForBytes(byteCount: number): Promise<number> {
  const response = await fetch(`https://payment.ardrive.io/v1/price/bytes/${byteCount}`);
  if (!response.ok) {
    throw new Error(`Turbo price request failed (${response.status})`);
  }
  const raw = await response.json();
  return parseNumber(raw?.winc);
}

export async function fetchL1CostForBytes(byteCount: number): Promise<number> {
  const Arweave = (await import('arweave')).default;
  const arweave = Arweave.init(arweaveDataGatewayHost());
  return parseNumber(await arweave.transactions.getPrice(byteCount));
}
