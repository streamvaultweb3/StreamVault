import { connect, createDataItemSigner } from '@permaweb/aoconnect';
import type { UdlConfig, RoyaltySplit } from './udl';

const ao = connect({ MODE: 'legacy' } as any);

const LICENSE_ENGINE_PROCESS =
  (import.meta as any).env?.VITE_AO_LICENSE_ENGINE_PROCESS ||
  (import.meta as any).env?.VITE_AO_LICENSE_ENGINE ||
  // Fallback to the known deployed process id so basic testing works
  'uJEUB-scKFXU2R2u9bW1rngnBH4_Rhnj2zefYyzeNXo';

export interface LicenseQuote {
  quoteId: string;
  assetId: string;
  useCase: string;
  payer: string;
  fee: number;
  currency: string;
  interval: string;
  expiresAt?: number;
  createdAt?: number;
}

export interface LicenseGrant {
  grantId: string;
  quoteId: string;
  assetId: string;
  useCase: string;
  payer: string;
  amount: number;
  currency: string;
  paymentTxId: string;
  createdAt?: number;
}

function ensureProcess(): string | null {
  if (!LICENSE_ENGINE_PROCESS) {
    console.warn('[ao] LICENSE_ENGINE_PROCESS env not set; skipping license engine calls');
    return null;
  }
  return LICENSE_ENGINE_PROCESS;
}

export async function requestLicenseOnAO(args: {
  assetId: string;
  useCase?: string;
  payer?: string;
  udl?: UdlConfig;
  feeOverride?: number;
  currencyOverride?: string;
  intervalOverride?: string;
}): Promise<LicenseQuote | null> {
  const process = ensureProcess();
  if (!process) return null;

  const payload: any = {
    Action: 'RequestLicense',
    AssetId: args.assetId,
    UseCase: args.useCase ?? 'access',
  };

  if (args.payer) payload.Payer = args.payer;
  if (args.udl) payload.UDL = args.udl;
  if (typeof args.feeOverride === 'number') payload.Fee = args.feeOverride;
  if (args.currencyOverride) payload.Currency = args.currencyOverride;
  if (args.intervalOverride) payload.Interval = args.intervalOverride;

  const res: any = await ao.dryrun({
    process,
    data: JSON.stringify(payload),
  });

  const msg = res.Messages?.[0];
  if (!msg || !msg.Data) return null;
  try {
    const parsed = JSON.parse(msg.Data);
    return parsed.Quote as LicenseQuote;
  } catch (e) {
    console.warn('[ao] Failed to parse RequestLicense quote', e);
    return null;
  }
}

export async function confirmLicensePaymentOnAO(args: {
  quoteId: string;
  paymentTxId: string;
  amount: number;
  currency: string;
  splits?: RoyaltySplit[];
}): Promise<LicenseGrant | null> {
  const process = ensureProcess();
  if (!process) return null;

  const win = typeof window !== 'undefined' ? (window as any) : null;
  const wallet = win?.arweaveWallet;
  if (!wallet) {
    console.warn('[ao] No arweaveWallet signer available; skipping ConfirmPayment message');
    return null;
  }

  const signer = createDataItemSigner(wallet);

  const payload: any = {
    Action: 'ConfirmPayment',
    QuoteId: args.quoteId,
    PaymentTxId: args.paymentTxId,
    Amount: args.amount,
    Currency: args.currency,
  };

  if (args.splits && args.splits.length > 0) {
    payload.Splits = args.splits;
  }

  await ao.message({
    process,
    data: JSON.stringify(payload),
    signer,
  });

  // For message(), AO will emit a subsequent message with the Grant.
  // To keep this helper simple, we return null here and rely on read helpers
  // (or the client) to fetch grants by id if needed.
  return null;
}
