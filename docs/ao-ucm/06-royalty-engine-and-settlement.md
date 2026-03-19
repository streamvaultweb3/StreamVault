# 5. Royalty Engine & Settlement ($U / MATIC)

## AO RoyaltyEngine process

```lua
Balances = Balances or {}

local function key(chain, token, addr)
  return chain .. ':' .. token .. ':' .. addr
end

Handlers.add('AccrueRoyalties', {
  Verify = function(m)
    return m.Action == 'AccrueRoyalties' and m.AssetId and m.Amount and m.Currency and m.Splits
  end,
  Handle = function(m)
    local amount = tonumber(m.Amount)
    for _, split in ipairs(m.Splits) do
      local share = math.floor(amount * (split.shareBps / 10000))
      local k = key(split.chain, split.token, split.address)
      Balances[k] = (Balances[k] or 0) + share
    end
    Send({ Target = m.From, Action = 'AccrueRoyalties:OK' })
  end,
})

Handlers.add('GetPayoutPlan', {
  Verify = function(m) return m.Action == 'GetPayoutPlan' end,
  Handle = function(m)
    Send({ Target = m.From, Action = 'GetPayoutPlan:Result', Balances = Balances })
  end,
})
```

## TypeScript settlement script (Polygon / MATIC)

```ts
import { connect } from '@permaweb/aoconnect';
import { ethers } from 'ethers';

const ao = connect();
const ROYALTY_PROCESS = '<royalty-engine-process-id>';

async function fetchPayoutPlan() {
  const res = await ao.read({
    process: ROYALTY_PROCESS,
    data: JSON.stringify({ Action: 'GetPayoutPlan' }),
  });
  return JSON.parse(res.Messages[1].Data).Balances as Record<string, number>;
}

async function settleMaticRoyalties() {
  const balances = await fetchPayoutPlan();
  const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL!);
  const wallet = new ethers.Wallet(process.env.TREASURY_PK!, provider);

  for (const [k, amount] of Object.entries(balances)) {
    const [chain, token, address] = k.split(':');
    if (chain !== 'polygon' || token !== 'MATIC') continue;
    const wei = BigInt(amount); // amount is assumed to be in wei-equivalent units
    if (wei === 0n) continue;
    const tx = await wallet.sendTransaction({ to: address, value: wei });
    console.log('Paid', address, 'tx', tx.hash);
    // Optionally: send AO message acknowledging payout and zeroing balance
  }
}
```

For **$U‑based payouts**, follow the same pattern but replace the EVM transfer step with AO‑native token transfers (or a dedicated U‑token AO process).

