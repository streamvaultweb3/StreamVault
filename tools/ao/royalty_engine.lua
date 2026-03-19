-- RoyaltyEngine: AO process that tracks accrued balances per (chain, token, address)
-- using simple basis-point splits for each paid usage event.

Config = Config or { Admin = nil }
Balances = Balances or {}
PayoutHistory = PayoutHistory or {} -- payoutId -> record

local function key(chain, token, addr)
  return chain .. ':' .. token .. ':' .. addr
end

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

Handlers.add('AccrueRoyalties', {
  Verify = function(m)
    return m.Action == 'AccrueRoyalties' and m.AssetId ~= nil and m.Amount ~= nil and m.Currency ~= nil and m.Splits ~= nil
  end,
  Handle = function(m)
    local amount = tonumber(m.Amount)
    if not amount or amount <= 0 then
      return
    end

    for _, split in ipairs(m.Splits) do
      local shareBps = tonumber(split.shareBps) or 0
      if shareBps > 0 then
        local share = math.floor(amount * (shareBps / 10000))
        if share > 0 then
          local k = key(split.chain or 'arweave', split.token or m.Currency, split.address)
          Balances[k] = (Balances[k] or 0) + share
        end
      end
    end

    Send({
      Target = m.From,
      Action = 'AccrueRoyalties:OK',
      AssetId = m.AssetId,
      Amount = amount,
    })
  end,
})

Handlers.add('GetPayoutPlan', {
  Verify = function(m)
    return m.Action == 'GetPayoutPlan'
  end,
  Handle = function(m)
    Send({
      Target = m.From,
      Action = 'GetPayoutPlan:Result',
      Balances = Balances,
    })
  end,
})

Handlers.add('GetBalance', {
  Verify = function(m)
    return m.Action == 'GetBalance' and m.Chain ~= nil and m.Token ~= nil and m.Address ~= nil
  end,
  Handle = function(m)
    local k = key(m.Chain, m.Token, m.Address)
    Send({
      Target = m.From,
      Action = 'GetBalance:Result',
      Key = k,
      Balance = Balances[k] or 0,
    })
  end,
})

Handlers.add('AcknowledgePayout', {
  Verify = function(m)
    return m.Action == 'AcknowledgePayout' and m.PayoutId ~= nil and m.Entries ~= nil
  end,
  Handle = function(m)
    -- This is used to prevent double-paying by decrementing balances after an off-chain payout.
    -- Restrict to Admin once set.
    if isString(Config.Admin) and not isAdmin(m) then
      Send({ Target = m.From, Action = 'AcknowledgePayout:ERR', Error = 'Unauthorized' })
      return
    end

    if PayoutHistory[m.PayoutId] ~= nil then
      Send({ Target = m.From, Action = 'AcknowledgePayout:ERR', Error = 'PayoutAlreadyRecorded' })
      return
    end

    local applied = {}
    for _, e in ipairs(m.Entries) do
      local chain = e.chain
      local token = e.token
      local address = e.address
      local amount = tonumber(e.amount) or 0
      if chain ~= nil and token ~= nil and address ~= nil and amount > 0 then
        local k = key(chain, token, address)
        local current = Balances[k] or 0
        local next = current - amount
        if next < 0 then next = 0 end
        Balances[k] = next
        table.insert(applied, { key = k, amount = amount, prev = current, next = next })
      end
    end

    PayoutHistory[m.PayoutId] = {
      payoutId = m.PayoutId,
      txId = m.TxId,
      entries = applied,
      createdAt = os.time(),
      from = m.From,
    }

    Send({
      Target = m.From,
      Action = 'AcknowledgePayout:OK',
      PayoutId = m.PayoutId,
      Applied = applied,
    })
  end,
})

Handlers.add('GetPayoutHistory', {
  Verify = function(m)
    return m.Action == 'GetPayoutHistory'
  end,
  Handle = function(m)
    Send({
      Target = m.From,
      Action = 'GetPayoutHistory:Result',
      PayoutHistory = PayoutHistory,
    })
  end,
})

