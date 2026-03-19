/**
 * Example royalty settlement script for StreamVault atomic assets.
 *
 * This script is NOT bundled into the frontend; it is intended to be run
 * from Node.js with appropriate environment variables:
 *
 * - POLYGON_RPC_URL   — HTTPS RPC endpoint for Polygon or Base (if you adapt it)
 * - TREASURY_PK       — private key for the treasury wallet paying out MATIC
 * - VITE_AO_ROYALTY_PROCESS — AO RoyaltyEngine process id (same as in the app)
 */
/* eslint-disable no-console */

import 'dotenv/config';
import { ethers } from 'ethers';
import { connect } from '@permaweb/aoconnect';

const ao = connect();

const ROYALTY_PROCESS =
  process.env.VITE_AO_ROYALTY_PROCESS ||
  process.env.VITE_AO_ROYALTY_ENGINE ||
  '';

async function fetchPayoutPlan(): Promise<Record<string, number>> {
  if (!ROYALTY_PROCESS) {
    throw new Error('ROYALTY_PROCESS env not set');
  }

  const res: any = await ao.dryrun({
    process: ROYALTY_PROCESS,
    data: JSON.stringify({ Action: 'GetPayoutPlan' }),
  });

  const msg = res.Messages?.[0];
  if (!msg?.Data) return {};
  try {
    const parsed = JSON.parse(msg.Data);
    return parsed.Balances as Record<string, number>;
  } catch (e) {
    console.warn('[royalties] Failed to parse GetPayoutPlan result', e);
    return {};
  }
}

async function settleMaticRoyalties() {
  const balances = await fetchPayoutPlan();
  const rpcUrl = process.env.POLYGON_RPC_URL;
  const treasuryPk = process.env.TREASURY_PK;

  if (!rpcUrl || !treasuryPk) {
    throw new Error('POLYGON_RPC_URL and TREASURY_PK env vars are required');
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(treasuryPk, provider);

  for (const [k, amount] of Object.entries(balances)) {
    const [chain, token, address] = k.split(':');
    if (chain !== 'polygon' || token !== 'MATIC') continue;
    const wei = BigInt(amount);
    if (wei === 0n) continue;

    console.log('[royalties] Paying', address, 'amount (wei)', wei.toString());
    const tx = await wallet.sendTransaction({ to: address, value: wei });
    console.log('[royalties] Tx hash', tx.hash);

    // Optional: send an AO message to zero-out this balance after payout.
    // await ao.message({
    //   process: ROYALTY_PROCESS,
    //   data: JSON.stringify({ Action: 'MarkPaid', Key: k, Amount: amount }),
    //   signer: createDataItemSigner(/* treasury wallet signer */),
    // });
  }
}

settleMaticRoyalties()
  .then(() => {
    console.log('[royalties] Settlement run completed');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[royalties] Settlement run failed', err);
    process.exit(1);
  });

