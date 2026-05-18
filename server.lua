local broadcastCooldown = {}  -- [src] = lastTimestamp
local COOLDOWN_MS = 2000

RegisterNetEvent('dj_console:broadcastMusic')
AddEventHandler('dj_console:broadcastMusic', function(data)
    local src = source
    local now = GetGameTimer()
    local range = 50.0

    -- Rate limiting: max 1 broadcast ogni 2 secondi per giocatore
    if broadcastCooldown[src] and (now - broadcastCooldown[src]) < COOLDOWN_MS then return end
    broadcastCooldown[src] = now

    -- Validazione input
    if type(data.url) ~= 'string' or #data.url == 0 or #data.url > 512 then return end
    if type(data.volume) ~= 'number' then data.volume = 0.5 end
    data.volume = math.max(0.0, math.min(1.0, data.volume))

    -- Coordinate del DJ lato server (non ci fidiamo del client)
    local srcPed = GetPlayerPed(src)
    local srcCoords = GetEntityCoords(srcPed)
    if srcCoords.x == 0.0 and srcCoords.y == 0.0 and srcCoords.z == 0.0 then return end

    for _, playerId in ipairs(GetPlayers()) do
        local pid = tonumber(playerId)
        if pid ~= src then
            local ped = GetPlayerPed(pid)
            local coords = GetEntityCoords(ped)
            if coords.x ~= 0.0 or coords.y ~= 0.0 or coords.z ~= 0.0 then
                local dist = #(coords - srcCoords)
                if dist <= range then
                    TriggerClientEvent('dj_console:playNearbyMusic', pid, {
                        url = data.url,
                        volume = data.volume,
                        range = range
                    })
                end
            end
        end
    end
end)

-- Pulizia cooldown quando un giocatore si disconnette
AddEventHandler('playerDropped', function()
    broadcastCooldown[source] = nil
end)
