# 3. Uploading a Song with UDL Tags (Bundlr + @permaweb/libs)

This example shows how to:

1. Upload audio to Arweave via **Bundlr** with UDL tags.
2. Mint an atomic asset with **@permaweb/libs** that references the uploaded audio and embeds the same license + splits in metadata.

```ts
import fs from 'node:fs';
import Bundlr from '@bundlr-network/client';
import Arweave from 'arweave';
import { connect, createDataItemSigner } from '@permaweb/aoconnect';
import Permaweb from '@permaweb/libs';

async function uploadTrackWithUDL() {
  const privateKey = JSON.parse(fs.readFileSync('./wallet.json', 'utf-8'));

  // 1) Upload audio via Bundlr (example: MATIC)
  const bundlr = new Bundlr('https://node1.bundlr.network', 'matic', process.env.MATIC_PRIVATE_KEY!);
  const data = fs.readFileSync('./audio/master.mp3');

  const tags = [
    { name: 'Content-Type', value: 'audio/mpeg' },
    { name: 'App-Name', value: 'StreamVault' },
    { name: 'License', value: 'udl://music/1.0' },
    { name: 'License-URI', value: 'ar://<udl-license-txid>' },
    { name: 'License-Use', value: 'stream,download' },
    { name: 'License-AI-Use', value: 'allow-train' },
    { name: 'License-Fee', value: '1' },
    { name: 'License-Fee-Unit', value: 'per-stream' },
    { name: 'License-Currency', value: 'MATIC' },
  ];

  const tx = bundlr.createTransaction(data, { tags });
  await tx.sign();
  await tx.upload();
  const audioTxId = tx.id;

  // 2) Mint atomic asset with @permaweb/libs
  const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });
  const permaweb = Permaweb.init({
    ao: connect(),
    arweave,
    signer: createDataItemSigner(privateKey),
  });

  const creatorAddress = await arweave.wallets.jwkToAddress(privateKey);

  const udl = {
    licenseId: 'udl://music/1.0',
    uri: 'ar://<udl-license-txid>',
    usage: ['stream', 'download'],
    aiUse: 'allow-train',
    fee: '1',
    currency: 'MATIC',
    interval: 'per-stream',
  };

  const splits = [
    { address: creatorAddress, shareBps: 9000, chain: 'polygon', token: 'MATIC' },
    { address: '0xCollaborator...', shareBps: 1000, chain: 'polygon', token: 'MATIC' },
  ];

  const assetId = await permaweb.createAtomicAsset({
    name: 'Example Track',
    description: 'Lead single from StreamVault EP',
    topics: ['Music', 'StreamVault'],
    creator: creatorAddress,
    data: `https://arweave.net/${audioTxId}`,
    contentType: 'text/plain',
    assetType: 'music-track',
    metadata: {
      audioTxId,
      durationSeconds: 180,
      royaltiesBps: 1000,
      splits,
      udl,
    },
    tags: [
      { name: 'App-Name', value: 'StreamVault' },
      { name: 'Track-Id', value: audioTxId },
      { name: 'License', value: udl.licenseId },
      { name: 'License-URI', value: udl.uri },
    ],
  });

  console.log('Minted atomic asset:', assetId);
}
```

