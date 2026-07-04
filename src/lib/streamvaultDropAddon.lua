-- StreamVault music drop claim handlers (Eval into atomic asset process after mint)
local json = require('json')

local bint
if type(_G.bint) == 'function' then
	bint = _G.bint
else
	local ok, res = pcall(function() return require('.bint')(256) end)
	bint = ok and res or nil
end

if not _G.checkValidAddress then
	_G.checkValidAddress = function(address)
		return type(address) == 'string' and #address == 43 and string.match(address, '^[%w%-_]+$') ~= nil
	end
end

checkValidAddress = _G.checkValidAddress

if not DropConfig then
	DropConfig = {
		TotalSupply = 1,
		ClaimPriceWinston = '0',
		DropMode = 'free',
		Name = 'StreamVault Drop',
	}
end

if not Claims then Claims = {} end

local function claimsCount()
	local n = 0
	for _ in pairs(Claims) do n = n + 1 end
	return n
end

local function getRemainingSupply()
	return (DropConfig.TotalSupply or 0) - claimsCount()
end

local function getOwner()
	return Owner or (Token and Token.Creator) or nil
end

local function getOwnerBalance()
	local owner = getOwner()
	if not owner or not Token or not Token.Balances then return '0' end
	return Token.Balances[owner] or '0'
end

local function ensureOwnerBalance()
	if not Token or not bint then return false end
	local owner = getOwner()
	if not owner then return false end
	if not Token.Balances then Token.Balances = {} end
	local bal = Token.Balances[owner] or '0'
	if bint(bal) <= bint(0) then
		local supply = tostring(DropConfig.TotalSupply or Token.TotalSupply or '1')
		Token.Balances[owner] = supply
		Token.TotalSupply = supply
		if not Token.Creator then Token.Creator = owner end
		return true
	end
	return false
end

local originalSyncState = _G.syncState
_G.syncState = function()
	if type(Send) == 'function' and Token and json then
		local state = {
			Name = Token.Name,
			Ticker = Token.Ticker,
			Denomination = tostring(Token.Denomination),
			Balances = Token.Balances,
			TotalSupply = Token.TotalSupply,
			Transferable = Token.Transferable,
			Creator = Token.Creator,
			Metadata = Metadata or {},
			DropConfig = DropConfig or {},
			Claims = Claims or {},
		}
		Send({ device = 'patch@1.0', asset = json.encode(state) })
	elseif originalSyncState and type(originalSyncState) == 'function' then
		originalSyncState()
	end
end
syncState = _G.syncState

pcall(function()
	ensureOwnerBalance()
	syncState()
end)

Handlers.add(
	'Get-Drop-Stats',
	Handlers.utils.hasMatchingTag('Action', 'Get-Drop-Stats'),
	function(msg)
		local claimed = claimsCount()
		msg.reply({
			Action = 'Drop-Stats-Response',
			Data = json.encode({
				TotalSupply = DropConfig.TotalSupply,
				Claimed = claimed,
				Remaining = getRemainingSupply(),
				ClaimPriceWinston = DropConfig.ClaimPriceWinston or '0',
				DropMode = DropConfig.DropMode or 'free',
				Name = DropConfig.Name,
			}),
		})
	end
)

Handlers.add(
	'Get-Claim-Status',
	Handlers.utils.hasMatchingTag('Action', 'Get-Claim-Status'),
	function(msg)
		local address = msg.Tags['Wallet-Address'] or msg.From
		if Claims[address] then
			msg.reply({
				Action = 'Claim-Status-Response',
				Tags = { Status = 'Already-Claimed' },
			})
			return
		end
		if getRemainingSupply() <= 0 then
			msg.reply({
				Action = 'Claim-Status-Response',
				Tags = { Status = 'Sold-Out' },
			})
			return
		end
		msg.reply({
			Action = 'Claim-Status-Response',
			Tags = {
				Status = 'Available',
				Remaining = tostring(getRemainingSupply()),
				Total = tostring(DropConfig.TotalSupply),
			},
		})
	end
)

Handlers.add(
	'Claim',
	Handlers.utils.hasMatchingTag('Action', 'Claim'),
	function(msg)
		local wallet = msg.Tags['Wallet-Address'] or msg.From
		local recipient = msg.Tags.Recipient or wallet

		if not checkValidAddress(recipient) then
			msg.reply({ Action = 'Claim-Error', Tags = { Status = 'Error', Message = 'Invalid recipient address' } })
			return
		end

		if Claims[wallet] then
			msg.reply({ Action = 'Claim-Error', Tags = { Status = 'Already-Claimed', Message = 'You already claimed this drop' } })
			return
		end

		if getRemainingSupply() <= 0 then
			msg.reply({ Action = 'Claim-Error', Tags = { Status = 'Sold-Out', Message = 'This drop is sold out' } })
			return
		end

		local price = DropConfig.ClaimPriceWinston or '0'
		if bint and bint(price) > bint(0) then
			msg.reply({
				Action = 'Claim-Error',
				Tags = {
					Status = 'Payment-Required',
					Message = 'Paid drops require marketplace checkout. List or buy via UCM.',
					ClaimPriceWinston = tostring(price),
				},
			})
			return
		end

		if not Token or not bint then
			msg.reply({ Action = 'Claim-Error', Tags = { Status = 'Error', Message = 'Token state unavailable' } })
			return
		end

		ensureOwnerBalance()
		local owner = getOwner()
		if not owner then
			msg.reply({ Action = 'Claim-Error', Tags = { Status = 'Error', Message = 'No owner configured' } })
			return
		end

		if not Token.Balances[owner] then Token.Balances[owner] = '0' end
		if not Token.Balances[recipient] then Token.Balances[recipient] = '0' end

		local ownerBal = bint(Token.Balances[owner])
		if ownerBal <= bint(0) then
			msg.reply({ Action = 'Claim-Error', Tags = { Status = 'Error', Message = 'No copies left to claim' } })
			return
		end

		Token.Balances[owner] = tostring(ownerBal - bint(1))
		Token.Balances[recipient] = tostring(bint(Token.Balances[recipient]) + bint(1))
		if bint(Token.Balances[owner]) <= bint(0) then Token.Balances[owner] = nil end

		Claims[wallet] = {
			Timestamp = msg.Timestamp,
			WalletAddress = wallet,
			Recipient = recipient,
		}

		if type(ao) == 'table' and type(ao.send) == 'function' then
			ao.send({
				Target = recipient,
				Action = 'Credit-Notice',
				Tags = {
					Status = 'Success',
					Message = 'StreamVault drop claimed',
					Sender = ao.id,
					Quantity = '1',
				},
				Data = json.encode({ Sender = ao.id, Quantity = '1' }),
			})
		end

		pcall(syncState)

		msg.reply({
			Action = 'Claim-Success',
			Data = json.encode({ recipient = recipient, assetId = ao.id }),
			Tags = { Status = 'Success' },
		})
	end
)

Handlers.add(
	'Sync-State',
	Handlers.utils.hasMatchingTag('Action', 'Sync-State'),
	function(msg)
		local ok, err = pcall(syncState)
		msg.reply({
			Action = 'Sync-State-Response',
			Tags = { Status = ok and 'Success' or 'Error', Message = ok and 'Synced' or tostring(err) },
		})
	end
)
