local json = require('json')

-- LicenseEngine: lightweight AO process to create auditable license quotes and grants.
-- It is designed to work alongside:
-- - Global UCM (trading/orderbook)
-- - StreamVault MusicRegistry (discovery)
-- - StreamVault RoyaltyEngine (accrual)
--
-- Notes:
-- - This process does NOT move tokens itself; it records quotes/grants and can optionally
--   notify a RoyaltyEngine process after payment is confirmed.
-- - Clients should supply enough UDL context to compute fees (or pass fee/currency explicitly).

Config = Config or { Admin = nil, RoyaltyEngineProcess = nil }
Quotes = Quotes or {} -- quoteId -> record
Grants = Grants or {} -- grantId -> record

local function isString(x)
  return type(x) == 'string' and x ~= ''
end

local function isNumber(x)
  return type(x) == 'number' and x == x
end

local function isAdmin(m)
  return isString(Config.Admin) and m.From == Config.Admin
end

local function now()
  return os.time()
end

local function makeId(prefix, from, assetId)
  -- Not cryptographically unique; sufficient for AO state keys.
  return prefix .. ':' .. tostring(from) .. ':' .. tostring(assetId) .. ':' .. tostring(now())
end

local function normalizeUdlFee(udl)
  -- UDL config may be passed in different shapes. We accept:
  -- udl.fee (string/number), udl.currency (string), udl.interval (string)
  if udl == nil then return nil end
  local fee = udl.fee
  if type(fee) == 'string' then fee = tonumber(fee) end
  if not isNumber(fee) or fee < 0 then fee = 0 end
  local currency = udl.currency
  if not isString(currency) then currency = 'U' end
  local interval = udl.interval
  if not isString(interval) then interval = 'one-time' end
  return { fee = fee, currency = currency, interval = interval }
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

Handlers.add('Init', {
  Verify = function(m)
    return m.Action == 'Init'
  end,
  Handle = function(m)
    -- Optional: set the RoyaltyEngine process id used for notifications.
    -- Only Admin (if set) may update this once configured.
    if m.RoyaltyEngineProcess ~= nil then
      if isString(Config.RoyaltyEngineProcess) and not isAdmin(m) then
        Send({ Target = m.From, Action = 'Init:ERR', Error = 'Unauthorized' })
        return
      end
      if not isString(m.RoyaltyEngineProcess) then
        Send({ Target = m.From, Action = 'Init:ERR', Error = 'InvalidRoyaltyEngineProcess' })
        return
      end
      Config.RoyaltyEngineProcess = m.RoyaltyEngineProcess
    end

    Send({
      Target = m.From,
      Action = 'Init:OK',
      RoyaltyEngineProcess = Config.RoyaltyEngineProcess,
    })
  end,
})

Handlers.add('RequestLicense', {
  Verify = function(m)
    return m.Action == 'RequestLicense' and m.AssetId ~= nil
  end,
  Handle = function(m)
    local assetId = m.AssetId
    local useCase = m.UseCase or 'access'
    local payer = m.Payer or m.From

    -- Prefer explicit fee/currency; otherwise derive from passed UDL object.
    local fee = m.Fee
    if type(fee) == 'string' then fee = tonumber(fee) end
    local currency = m.Currency
    local interval = m.Interval

    if (not isNumber(fee)) or fee < 0 then
      local n = normalizeUdlFee(m.UDL)
      if n ~= nil then
        fee = n.fee
        currency = currency or n.currency
        interval = interval or n.interval
      else
        fee = 0
        currency = currency or 'U'
        interval = interval or 'one-time'
      end
    end

    if not isString(currency) then currency = 'U' end
    if not isString(interval) then interval = 'one-time' end

    local quoteId = makeId('quote', payer, assetId)
    local expiresAt = m.ExpiresAt or (now() + 15 * 60) -- 15 minutes default

    local quote = {
      quoteId = quoteId,
      assetId = assetId,
      useCase = useCase,
      payer = payer,
      fee = fee,
      currency = currency,
      interval = interval,
      expiresAt = expiresAt,
      createdAt = now(),
    }

    Quotes[quoteId] = quote

    Send({
      Target = m.From,
      Action = 'RequestLicense:Quote',
      Quote = quote,
    })
  end,
})

Handlers.add('GetQuote', {
  Verify = function(m)
    return m.Action == 'GetQuote' and m.QuoteId ~= nil
  end,
  Handle = function(m)
    Send({
      Target = m.From,
      Action = 'GetQuote:Result',
      Quote = Quotes[m.QuoteId],
    })
  end,
})

Handlers.add('ConfirmPayment', {
  Verify = function(m)
    return m.Action == 'ConfirmPayment' and m.QuoteId ~= nil and m.PaymentTxId ~= nil
  end,
  Handle = function(m)
    local quote = Quotes[m.QuoteId]
    if quote == nil then
      Send({ Target = m.From, Action = 'ConfirmPayment:ERR', Error = 'QuoteNotFound' })
      return
    end

    if quote.expiresAt ~= nil and now() > quote.expiresAt then
      Send({ Target = m.From, Action = 'ConfirmPayment:ERR', Error = 'QuoteExpired' })
      return
    end

    -- Basic sanity checks (clients should pass exact values).
    local amount = m.Amount
    if type(amount) == 'string' then amount = tonumber(amount) end
    if not isNumber(amount) then amount = quote.fee end

    local currency = m.Currency or quote.currency
    if not isString(currency) then currency = quote.currency end

    if currency ~= quote.currency then
      Send({ Target = m.From, Action = 'ConfirmPayment:ERR', Error = 'CurrencyMismatch' })
      return
    end

    if amount < quote.fee then
      Send({ Target = m.From, Action = 'ConfirmPayment:ERR', Error = 'Underpaid' })
      return
    end

    local grantId = makeId('grant', quote.payer, quote.assetId)
    local grant = {
      grantId = grantId,
      quoteId = quote.quoteId,
      assetId = quote.assetId,
      useCase = quote.useCase,
      payer = quote.payer,
      amount = amount,
      currency = currency,
      paymentTxId = m.PaymentTxId,
      createdAt = now(),
    }

    Grants[grantId] = grant

    -- Optional notification to RoyaltyEngine for accrual (if configured).
    -- This is deliberately minimal: the client can also call RoyaltyEngine directly.
    if isString(Config.RoyaltyEngineProcess) and m.Splits ~= nil then
      Send({
        Target = Config.RoyaltyEngineProcess,
        Action = 'AccrueRoyalties',
        AssetId = quote.assetId,
        Amount = tostring(amount),
        Currency = currency,
        Splits = m.Splits,
      })
    end

    Send({
      Target = m.From,
      Action = 'ConfirmPayment:OK',
      Grant = grant,
    })
  end,
})

Handlers.add('GetGrant', {
  Verify = function(m)
    return m.Action == 'GetGrant' and m.GrantId ~= nil
  end,
  Handle = function(m)
    Send({
      Target = m.From,
      Action = 'GetGrant:Result',
      Grant = Grants[m.GrantId],
    })
  end,
})

