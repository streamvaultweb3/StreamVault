# 4. AO Track Registry & Discovery

## Lua MusicRegistry process

```lua
local json = require('json')

Tracks = Tracks or {}

Handlers.add('RegisterTrack', {
  Verify = function(m)
    return m.Action == 'RegisterTrack' and m.From ~= nil and m.AssetId ~= nil
  end,
  Handle = function(m)
    local assetId = m.AssetId
    local record = {
      assetId = assetId,
      audioTxId = m.AudioTxId,
      creator = m.Creator,
      udl = m.UDL,
      splits = m.Splits,
      tags = m.Tags,
      createdAt = m.CreatedAt or os.time(),
    }
    Tracks[assetId] = record
    Send({ Target = m.From, Action = 'RegisterTrack:OK', AssetId = assetId })
  end,
})

Handlers.add('SearchTracks', {
  Verify = function(m) return m.Action == 'SearchTracks' end,
  Handle = function(m)
    local q = m.Query or {}
    local results = {}
    for _, track in pairs(Tracks) do
      local match = true
      if q.Creator and track.creator ~= q.Creator then match = false end
      if q.License and track.udl and track.udl.licenseId ~= q.License then match = false end
      if q.AIUse and track.udl and track.udl.aiUse ~= q.AIUse then match = false end
      if match then table.insert(results, track) end
    end
    Send({ Target = m.From, Action = 'SearchTracks:Result', Results = results })
  end,
})
```

## TypeScript helpers via @permaweb/aoconnect

```ts
import { connect } from '@permaweb/aoconnect';

const ao = connect();
const MUSIC_REGISTRY_PROCESS = '<music-registry-process-id>';

export async function registerTrackOnAO(args: {
  assetId: string;
  audioTxId: string;
  creator: string;
  udl: any;
  splits: any[];
  tags: Record<string, string>;
}) {
  await ao.send({
    process: MUSIC_REGISTRY_PROCESS,
    signer: 'arweave', // via createDataItemSigner in your app
    data: JSON.stringify({
      Action: 'RegisterTrack',
      AssetId: args.assetId,
      AudioTxId: args.audioTxId,
      Creator: args.creator,
      UDL: args.udl,
      Splits: args.splits,
      Tags: args.tags,
    }),
  });
}

export async function searchTracks(query: { creator?: string; license?: string; aiUse?: string }) {
  const result = await ao.read({
    process: MUSIC_REGISTRY_PROCESS,
    data: JSON.stringify({ Action: 'SearchTracks', Query: query }),
  });
  return JSON.parse(result.Messages[1].Data).Results;
}
```

