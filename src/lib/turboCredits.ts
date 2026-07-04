export const TURBO_BALANCE_ENDPOINT = 'https://payment.ardrive.io/v1/balance';
const WINC_PER_CREDIT = 1_000_000_000_000;

export type TurboApproval = {
  payingAddress?: string;
  amount?: number | string;
  qty?: number | string;
  value?: number | string;
  winc?: number | string;
  approvedAmount?: number | string;
  approvedWincAmount?: number | string;
  remainingBalance?: number | string;
  balance?: number | string;
};

export type TurboBalance = {
  controlledBalance: number;
  effectiveBalance: number;
  receivedApprovals: TurboApproval[];
  givenApprovals: TurboApproval[];
};

function parseTurboNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function extractApprovalAmount(approval: TurboApproval): number {
  return parseTurboNumber(
    approval.amount ??
    approval.qty ??
    approval.value ??
    approval.winc ??
    approval.approvedAmount ??
    approval.approvedWincAmount ??
    approval.remainingBalance ??
    approval.balance ??
    0
  );
}

export function formatTurboCredits(value: number): string {
  return `${(value / WINC_PER_CREDIT).toFixed(4)} Credits`;
}

export async function fetchTurboBalance(address: string): Promise<TurboBalance> {
  const url = `${TURBO_BALANCE_ENDPOINT}?address=${encodeURIComponent(address)}`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) {
        throw new Error(`Turbo balance request failed (${response.status})`);
      }
      const raw = await response.json();
      return {
        controlledBalance: parseTurboNumber(raw?.controlledBalance),
        effectiveBalance: parseTurboNumber(raw?.effectiveBalance),
        receivedApprovals: Array.isArray(raw?.receivedApprovals) ? raw.receivedApprovals : [],
        givenApprovals: Array.isArray(raw?.givenApprovals) ? raw.givenApprovals : [],
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : 'Failed to fetch Turbo credits.';
  throw new Error(message);
}
