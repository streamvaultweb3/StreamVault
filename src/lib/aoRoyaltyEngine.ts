import { connect, createDataItemSigner } from '@permaweb/aoconnect';
import type { RoyaltySplit } from './udl';

const ao = connect({ MODE: 'legacy' } as any);

const ROYALTY_PROCESS =
  (import.meta as any).env?.VITE_AO_ROYALTY_PROCESS ||
  (import.meta as any).env?.VITE_AO_ROYALTY_ENGINE ||
  // Fallback to the known deployed process id so the app works
  // even without env configuration.
  'Xo4CJ9eym0cYlZ2FGO8KUwTAh3WQ_0cEVwpk8zxVawo';

export async function accrueRoyaltiesOnAO(args: {
  assetId: string;
  amount: string;
  currency: string;
  splits: RoyaltySplit[];
}): Promise<void> {
  if (!ROYALTY_PROCESS) {
    console.warn('[ao] ROYALTY_PROCESS env not set; skipping royalty accrual');
    return;
  }

  const payload = {
    Action: 'AccrueRoyalties',
    AssetId: args.assetId,
    Amount: args.amount,
    Currency: args.currency,
    Splits: args.splits,
  };

  const win = typeof window !== 'undefined' ? (window as any) : null;
  const wallet = win?.arweaveWallet;
  if (!wallet) {
    console.warn('[ao] No arweaveWallet signer available; skipping AccrueRoyalties message');
    return;
  }

  const signer = createDataItemSigner(wallet);

  await ao.message({
    process: ROYALTY_PROCESS,
    data: JSON.stringify(payload),
    signer,
  });
}

export async function getRoyaltyPayoutPlan(): Promise<Record<string, number>> {
  if (!ROYALTY_PROCESS) {
    console.warn('[ao] ROYALTY_PROCESS env not set; payout plan will be empty');
    return {};
  }

  const res: any = await ao.dryrun({
    process: ROYALTY_PROCESS,
    data: JSON.stringify({ Action: 'GetPayoutPlan' }),
  });

  const msg = res.Messages?.[0];
  if (!msg || !msg.Data) return {};
  try {
    const parsed = JSON.parse(msg.Data);
    return parsed.Balances as Record<string, number>;
  } catch (e) {
    console.warn('[ao] Failed to parse GetPayoutPlan result', e);
    return {};
  }
}
