local json = require('json')

-- Simple in-process registry of music atomic assets with UDL metadata.
-- Tracks are registered by assetId and can be searched by creator, license, and AI-use flags.

Tracks = Tracks or {}
Config = Config or { Admin = nil }

local function isString(x)
  return type(x) == 'string' and x ~= ''
end

local function isAdmin(m)
  return isString(Config.Admin) and m.From == Config.Admin
end

Handlers.add('SetAdmin', {
  Verify = function(m)
    return m.Action == 'SetAdmin' and m.Admin ~= nil
  end,
  Handle = function(m)
    if isString(Config.Admin) then
      Send({ Target = m.From, Action = 'SetAdmin:ERR', Error = 'AdminAlreadySet' })
      return
    end
    if not isString(m.Admin) then
      Send({ Target = m.From, Action = 'SetAdmin:ERR', Error = 'InvalidAdmin' })
      return
    end
    Config.Admin = m.Admin
    Send({ Target = m.From, Action = 'SetAdmin:OK', Admin = Config.Admin })
  end,
})

Handlers.add('RegisterTrack', {
  Verify = function(m)
    return m.Action == 'RegisterTrack' and m.AssetId ~= nil and m.Creator ~= nil
  end,
  Handle = function(m)
    -- By default, only the creator (signer) can register.
    if m.From ~= m.Creator and not isAdmin(m) then
      Send({ Target = m.From, Action = 'RegisterTrack:ERR', Error = 'Unauthorized' })
      return
    end

    local assetId = m.AssetId
    local record = {
      assetId = assetId,
      audioTxId = m.AudioTxId,
      creator = m.Creator,
      udl = m.UDL,
      splits = m.Splits,
      tags = m.Tags,
      createdAt = m.CreatedAt or os.time(),
      updatedAt = os.time(),
    }

    Tracks[assetId] = record

    Send({
      Target = m.From,
      Action = 'RegisterTrack:OK',
      AssetId = assetId,
    })
  end,
})

Handlers.add('GetTrack', {
  Verify = function(m)
    return m.Action == 'GetTrack' and m.AssetId ~= nil
  end,
  Handle = function(m)
    local record = Tracks[m.AssetId]
    Send({
      Target = m.From,
      Action = 'GetTrack:Result',
      Track = record,
    })
  end,
})

Handlers.add('UpdateTrackMeta', {
  Verify = function(m)
    return m.Action == 'UpdateTrackMeta' and m.AssetId ~= nil
  end,
  Handle = function(m)
    local record = Tracks[m.AssetId]
    if record == nil then
      Send({ Target = m.From, Action = 'UpdateTrackMeta:ERR', Error = 'NotFound' })
      return
    end

    if m.From ~= record.creator and not isAdmin(m) then
      Send({ Target = m.From, Action = 'UpdateTrackMeta:ERR', Error = 'Unauthorized' })
      return
    end

    -- Only allow non-license-sensitive updates via this message.
    -- (UDL + splits should be treated as immutable or updated via a stricter flow.)
    if m.AudioTxId ~= nil then record.audioTxId = m.AudioTxId end
    if m.Tags ~= nil then record.tags = m.Tags end
    record.updatedAt = os.time()
    Tracks[m.AssetId] = record

    Send({ Target = m.From, Action = 'UpdateTrackMeta:OK', AssetId = m.AssetId })
  end,
})

Handlers.add('SearchTracks', {
  Verify = function(m)
    return m.Action == 'SearchTracks'
  end,
  Handle = function(m)
    local q = m.Query or {}
    local results = {}

    for _, track in pairs(Tracks) do
      local match = true

      if q.Creator and track.creator ~= q.Creator then
        match = false
      end

      if q.License and track.udl and track.udl.licenseId ~= q.License then
        match = false
      end

      if q.AIUse and track.udl and track.udl.aiUse ~= q.AIUse then
        match = false
      end

      if q.TagName and q.TagValue and track.tags ~= nil then
        local v = track.tags[q.TagName]
        if v ~= q.TagValue then
          match = false
        end
      end

      if match then
        table.insert(results, track)
      end
    end

    Send({
      Target = m.From,
      Action = 'SearchTracks:Result',
      Results = results,
    })
  end,
})

