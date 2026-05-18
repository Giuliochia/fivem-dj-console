local isOpen = false
local soundHandles = {}

-- Apri/chiudi la consolle DJ
RegisterCommand('djconsole', function()
    if isOpen then
        CloseConsole()
    else
        OpenConsole()
    end
end, false)

RegisterKeyMapping('djconsole', 'Apri Consolle DJ', 'keyboard', 'F5')

function OpenConsole()
    isOpen = true
    SetNuiFocus(true, true)
    SendNUIMessage({ action = 'open' })
end

function CloseConsole()
    isOpen = false
    SetNuiFocus(false, false)
    SendNUIMessage({ action = 'close' })
end

-- Ricezione comandi dalla UI
-- L'audio viene gestito interamente dalla Web Audio API nel NUI (app.js).
-- Qui teniamo solo il tracciamento dello stato per il broadcast.
RegisterNUICallback('playDeck', function(data, cb)
    soundHandles[data.deck] = data.url
    cb({ success = true })
end)

RegisterNUICallback('stopDeck', function(data, cb)
    soundHandles[data.deck] = nil
    cb({ success = true })
end)

RegisterNUICallback('setVolume', function(data, cb)
    -- Il volume master viene gestito lato NUI con Web Audio API
    cb({ success = true })
end)

RegisterNUICallback('close', function(data, cb)
    CloseConsole()
    cb({ success = true })
end)

-- Broadcast musica agli altri giocatori vicini
RegisterNUICallback('broadcastMusic', function(data, cb)
    local playerCoords = GetEntityCoords(PlayerPedId())
    TriggerServerEvent('dj_console:broadcastMusic', {
        url = data.url,
        volume = data.volume,
        coords = { x = playerCoords.x, y = playerCoords.y, z = playerCoords.z }
    })
    cb({ success = true })
end)

-- Ricezione broadcast da altri DJ
RegisterNetEvent('dj_console:playNearbyMusic')
AddEventHandler('dj_console:playNearbyMusic', function(data)
    -- Il NUI gestisce la riproduzione dello stream URL
    SendNUIMessage({
        action = 'playNearbyMusic',
        url = data.url,
        volume = data.volume or 0.5
    })
end)
