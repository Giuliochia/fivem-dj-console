# DJ Console — FiveM Resource

Una consolle DJ a due deck completamente funzionale per FiveM, con audio gestito interamente tramite Web Audio API nel NUI. Non dipende da risorse audio native di GTA5, che non supportano streaming di URL arbitrari.

---

## Struttura del progetto

```
djconsolle/
├── fxmanifest.lua     manifest FiveM
├── client.lua         logica client: apertura UI, focus NUI, broadcast
├── server.lua         logica server: validazione, rate limiting, proximity check
└── html/
    ├── index.html     struttura DOM della consolle
    ├── style.css      stili, animazioni, temi cromatici
    └── app.js         audio engine completo (Web Audio API)
```

---

## Requisiti

- **FiveM** con framework **ESX** installato sul server (non più richiesto direttamente da questo script, ma può coesistere)
- Nessuna dipendenza da risorse audio esterne (`xsound`, `mumble`, ecc.)
- Il browser NUI di FiveM supporta `Web Audio API` e `AudioContext` — funziona out of the box

---

## Installazione

1. Copia la cartella `djconsolle` nella directory `resources/` del tuo server FiveM
2. Aggiungi `ensure djconsolle` al tuo `server.cfg`
3. Riavvia il server

---

## Come aprire la consolle

| Metodo | Azione |
|--------|--------|
| Tasto | `F5` (configurabile da tastiera FiveM) |
| Chat | `/djconsole` |
| Chiudi | `ESC` o pulsante `✕` |

Il keybinding è registrato con `RegisterKeyMapping` e può essere modificato dal giocatore in **Impostazioni → Controllo → Keybindings → FiveM** senza toccare il codice.

---

## Architettura audio

### Perché solo NUI?

L'audio nativo di GTA5 (`PlaySoundFrontend`, `PlaySoundFromCoord`) lavora esclusivamente su suoni precaricati nei DLC del gioco. Non è possibile passare un URL HTTP a queste funzioni. Tutto l'audio del DJ Console è quindi gestito da `Web Audio API` nel layer NUI (Chromium embedded), che supporta `HTMLAudioElement` con `crossOrigin` e streaming live.

### Grafo audio per ogni deck

```
HTMLAudioElement
      │
MediaElementSourceNode
      │
  GainNode  ◄──── volume deck × crossfade equal-power
      │
  BiquadFilter (lowshelf  200Hz)   ← EQ LO
      │
  BiquadFilter (peaking  1000Hz)   ← EQ MID
      │
  BiquadFilter (highshelf 8000Hz)  ← EQ HI
      │
  ┌───────────────────────────────────────────────────┐
  │                   FX Chain                        │
  │  input ──► dryGain ─────────────────────────────┐ │
  │         ──► echoDelay → echoFeedback ⟲           │ │
  │                      └─► echoWet ───────────────┤ │
  │         ──► reverbConvolver ──► reverbWet ───────┤ │
  │         ──► flangerDelay ← LFO(0.3Hz)            │ │
  │              └─► flangerFeedback ⟲               │ │
  │              └─► flangerWet ────────────────────┤ │
  │         ──► filterBiquad(lowpass) ──► filterWet ─┤ │
  │                                                  ▼ │
  │                                              output │
  └───────────────────────────────────────────────────┘
      │
  AnalyserNode (fftSize 512)    ← VU meter
      │
  MasterGainNode
      │
  AudioContext.destination
      │
  AnalyserNode (fftSize 1024)   ← BPM detection (solo lettura, no audio output)
```

> Il `bpmAnalyser` è connesso a `fxChain.output` ma non a `masterGain`: legge il segnale senza contribuire all'output audio.

---

## Funzionalità dettagliate

### Deck A / Deck B

Ogni deck è indipendente e mantiene il proprio stato in `decks.A` e `decks.B`:

```js
{
    audio: HTMLAudioElement,    // elemento audio sorgente
    source: MediaElementSourceNode,
    gainNode: GainNode,         // volume × crossfade
    eq: { hi, mid, lo },        // BiquadFilterNode
    fxChain: { ... },           // nodi FX
    analyser, analyserData,     // VU meter
    bpmAnalyser, bpmData,       // beat detection
    playing: bool,
    cueTime: number,            // posizione CUE salvata (secondi)
    currentUrl: string,
    currentBPM: number | null,
    loopActive: bool,
    loopStart, loopEnd,         // punti di loop (secondi)
    cuePreview: bool,           // flag preview CUE attivo
    bpmHistory: number[],       // ultimi 12 intervalli beat
    lastBeatTime, lastEnergy    // stato rilevazione BPM
}
```

**Al cambio URL** (`currentUrl !== url`): l'elemento `Audio` e il `MediaElementSourceNode` vengono ricreati da zero per evitare la limitazione di Chrome che consente un solo `MediaElementSource` per `HTMLAudioElement`.

---

### EQ (3 bande)

Ogni banda è un `BiquadFilterNode` con range ±12dB, controllato da knob drag (trascinamento verticale):

| Banda | Tipo | Frequenza | Centro knob | Range dB |
|-------|------|-----------|-------------|----------|
| LO | `lowshelf` | 200 Hz | 75/150 | -12 → +12 |
| MID | `peaking` Q=1 | 1000 Hz | 75/150 | -12 → +12 |
| HI | `highshelf` | 8000 Hz | 75/150 | -12 → +12 |

Formula: `gain = ((val - 75) / 75) * 12`

---

### FX (effetti audio)

Gli FX operano su entrambi i deck simultaneamente tramite una catena dry/wet parallela. Il knob **DEPTH** (0–150) controlla l'intensità.

#### ECHO
- `DelayNode`: 350ms di ritardo
- `GainNode` feedback: 0.4 (il segnale ritardato si rialiementa nel delay)
- Wet gain: `depth × 0.7`
- Dry ridotto proporzionalmente a `depth × 0.3`

#### REVERB
- `ConvolverNode` con impulse response sintetica generata a runtime da `buildImpulseResponse(2.5s, decay=2.0)`
- L'impulso è rumore bianco con decadimento esponenziale, stereo
- Wet gain: `depth × 0.6`
- Dry ridotto a `depth × 0.2`

#### FLANGER
- `DelayNode` base: 3ms
- `OscillatorNode` LFO a 0.3Hz modula il delay time ±2ms (`flangerLFOGain.gain = 0.002`)
- `GainNode` feedback: 0.6 (crea il caratteristico suono metallico)
- Il LFO viene avviato (`lfo.start()`) alla creazione e fermato (`lfo.stop()`) al teardown

#### FILTER
- `BiquadFilterNode` tipo `lowpass`, Q=8 (risonanza alta per effetto "wah")
- Quando attivo: sostituisce completamente il dry (`dryGain = 0`, `filterWet = 1`)
- La frequenza di taglio varia in tempo reale con DEPTH: `200Hz + depth × 7800Hz`
- Il knob DEPTH aggiorna il cutoff istantaneamente tramite `setTargetAtTime`

> **Nota**: più FX possono essere attivi contemporaneamente. `recomputeDryGain()` ricalcola il contributo dry ogni volta che un FX viene attivato/disattivato o il DEPTH cambia.

---

### Crossfader (equal-power)

Formula standard dei mixer DJ professionali. Evita il calo di volume percepito al centro:

```
Deck A gain = base_A × cos(cf × π/2)
Deck B gain = base_B × sin(cf × π/2)
```

- `cf = 0` → Deck A a piena potenza, Deck B silenzioso
- `cf = 0.5` → entrambi a 0.707 (-3dB), potenza totale invariata
- `cf = 1` → Deck B a piena potenza, Deck A silenzioso

Il crossfade è applicato in `updateDeckVolume` e ricalcolato ogni volta che si muove il fader o il crossfader.

---

### CUE point

Il bottone CUE ha comportamento diverso in base allo stato del deck:

| Stato deck | Azione mousedown | Azione mouseup/mouseleave |
|------------|-----------------|--------------------------|
| **In play** | Salva `cueTime = currentTime`, flash visivo | — |
| **In pausa** | Salta a `cueTime`, avvia preview (`cuePreview = true`) | Ferma preview, ritorna a `cueTime` |

Il bottone usa `mousedown`/`mouseup`/`mouseleave` invece di `click` per permettere il preview "a pressione". L'`onclick` HTML è rimosso programmaticamente da `setupCueButtons()`.

---

### Loop

I bottoni selezionano la durata del loop in misure musicali (½, 1, 2, 4, 8 bars in 4/4).

**Calcolo della durata**:
```
loopDuration = bars × 4 beats × (60 / BPM)
```

Se il BPM non è ancora stato rilevato, viene usato 120 come default.

**Meccanismo**: ogni frame RAF, `checkLoop()` confronta `audio.currentTime >= loopEnd` e fa il jump a `loopStart`.

> **Limitazione**: il loop funziona solo su file MP3/audio scaricabili (che supportano seeking). Su stream radio live, `currentTime` non è seek-able e il jump viene ignorato dal browser.

**Toggle**: cliccare di nuovo lo stesso bottone attivo disattiva il loop.

---

### BPM Detection

Rilevazione energy-based sulla banda bassa (60–200Hz), dove si trovano le frequenze della cassa.

**Funzionamento**:
1. Ogni frame RAF, `getByteFrequencyData` legge i dati FFT dal `bpmAnalyser`
2. Si calcola l'energia media dei bin 1–5 (≈43–215Hz) su una scala 0–255
3. Quando l'energia supera la soglia 130 (fronte di salita), viene registrato un beat
4. L'intervallo tra beat consecutivi viene aggiunto a `bpmHistory` (max 12 valori)
5. La media degli intervalli viene convertita in BPM: `60 / avgInterval`
6. Valori fuori range 60–200 BPM vengono scartati

Il display si aggiorna in tempo reale. Il BPM si azzera ad ogni cambio URL.

---

### VU Meter

8 barre per deck, alimentate da dati reali dell'`AnalyserNode` (non simulati):

1. `getByteFrequencyData` riempie `analyserData` con 256 valori 0–255
2. Si calcola il livello medio: `sum / (length × 255)`
3. Le barre si colorano: verde (0–3), giallo (4–5), rosso (6–7)

`smoothingTimeConstant = 0.8` sull'analyser evita sfarfallii troppo rapidi.

---

### RAF Loop unificato

Un singolo `requestAnimationFrame` gestisce tutto ciò che deve aggiornarsi ogni frame:

```
startRaf()
  └── loop()
        ├── animateVU('vu-a', decks.A)
        ├── animateVU('vu-b', decks.B)
        ├── detectBPM('A')
        ├── detectBPM('B')
        ├── updateTimerDisplay('A')
        ├── updateTimerDisplay('B')
        ├── checkLoop('A')
        ├── checkLoop('B')
        └── if (A.playing || B.playing) → requestAnimationFrame(loop)
            else → vuRafId = null  [loop si auto-ferma]
```

Il loop si avvia solo quando almeno un deck inizia la riproduzione e si ferma automaticamente quando entrambi i deck si fermano. Non c'è polling continuo quando la consolle è inattiva.

---

### Broadcast (multiplayer)

Permette al DJ di trasmettere la propria musica ai giocatori nelle vicinanze.

**Flusso**:
```
[NUI] toggleBroadcast()
  └── sendBroadcast()
        └── postNUI('broadcastMusic', { url, volume })
              └── [client.lua] TriggerServerEvent('dj_console:broadcastMusic', data)
                    └── [server.lua] validazione + proximity check
                          └── TriggerClientEvent('dj_console:playNearbyMusic', pid, data)
                                └── [client.lua] SendNUIMessage({ action: 'playNearbyMusic' })
                                      └── [NUI] playNearbyMusic(url, volume)
```

**Range**: 50 unità GTA (circa 50 metri)

**Heartbeat**: quando il broadcast è attivo, `sendBroadcast()` viene richiamata ogni 30 secondi per sincronizzare i giocatori che entrano nel raggio durante la trasmissione.

**Ri-broadcast automatico**: ogni volta che `playDeck()` viene chiamato con broadcast attivo, viene inviato automaticamente il nuovo URL.

---

### URL History

Gli ultimi 10 URL usati per ogni deck vengono salvati in `localStorage` con chiave `dj_history_A` / `dj_history_B`. Al caricamento del NUI, i dati vengono ripristinati e collegati al `<datalist>` associato all'input: il browser mostra i suggerimenti automaticamente.

---

### Persistenza preferenze

Salvate in `localStorage` con prefisso `dj_`:

| Chiave | Default | Descrizione |
|--------|---------|-------------|
| `dj_masterVol` | 80 | Volume master (0–100) |
| `dj_volA` | 80 | Volume deck A (0–100) |
| `dj_volB` | 80 | Volume deck B (0–100) |
| `dj_crossfader` | 50 | Posizione crossfader (0–100) |

Ripristinate all'apertura della pagina tramite `restorePrefs()`.

---

## Comunicazione Lua ↔ NUI

### NUI → Lua (`postNUI`)

| Action | Payload | Descrizione |
|--------|---------|-------------|
| `playDeck` | `{ deck, url, volume }` | Deck avviato |
| `stopDeck` | `{ deck }` | Deck fermato |
| `setVolume` | `{ type, value }` | Volume aggiornato |
| `broadcastMusic` | `{ url, volume }` | Avvia broadcast |
| `close` | `{}` | Chiude la UI |

### Lua → NUI (`SendNUIMessage`)

| Action | Payload | Descrizione |
|--------|---------|-------------|
| `open` | — | Apre la consolle |
| `close` | — | Chiude la consolle |
| `playNearbyMusic` | `{ url, volume }` | Riproduci musica broadcast ricevuta |

---

## Sicurezza server

`server.lua` applica le seguenti protezioni:

1. **Rate limiting**: max 1 broadcast ogni 2000ms per `source`. La tabella `broadcastCooldown` viene pulita su `playerDropped`.
2. **Validazione URL**: `type == 'string'`, lunghezza 1–512 caratteri.
3. **Clamp volume**: `math.max(0.0, math.min(1.0, volume))`.
4. **Coordinate server-authoritative**: le coordinate del DJ vengono lette lato server (`GetEntityCoords(GetPlayerPed(src))`), non fidate dal client.
5. **Skip ped non spawned**: coordinate `0,0,0` vengono scartate.

---

## Keyboard shortcuts

| Tasto | Azione |
|-------|--------|
| `F5` | Apri/chiudi consolle (keybinding FiveM) |
| `ESC` | Chiudi consolle |
| `Enter` (input URL A) | Avvia/pausa Deck A |
| `Enter` (input URL B) | Avvia/pausa Deck B |

---

## Estendere lo script

### Aggiungere un effetto FX

1. In `buildFXChain()`, crea i nodi necessari e connettili a `input`/`output`
2. Aggiungili all'oggetto restituito dalla funzione
3. In `applyFXToDeck()`, aggiungi il branch `else if (name === 'nomefx')`
4. In `teardownDeckChain()`, aggiungi il `disconnect()` dei nuovi nodi
5. In `index.html`, aggiungi `<button class="fx-btn" id="fx-nomefx" onclick="toggleFX('nomefx')">NOME</button>`

### Cambiare il range di broadcast

In `server.lua`, modifica la variabile `range` (riga 8). Il valore è in unità GTA (1 unità ≈ 1 metro).

### Cambiare il cooldown broadcast

In `server.lua`, modifica `COOLDOWN_MS` (riga 2). Valore in millisecondi.

### Aggiungere un terzo deck

1. Aggiungi il DOM del deck in `index.html` (copia `.deck-a`, rinomina in `.deck-c`)
2. Inizializza `decks.C = makeDeck()` in `app.js`
3. Aggiorna `startRaf()` per includere deck C nelle chiamate
4. Aggiorna il crossfader (attualmente supporta solo A/B con equal-power a 2 canali)

---

## Limitazioni note

- **Loop su stream live**: non funziona — gli stream radio non supportano seeking del `currentTime`.
- **BPM detection su stream**: funziona bene su musica con cassa evidente (elettronica, house). Può essere imprecisa su generi con bassi morbidi o poco enfatizzati.
- **CORS**: l'audio remoto richiede che il server sorgente abbia gli header CORS corretti (`Access-Control-Allow-Origin: *`). La maggior parte delle radio online li supporta. File MP3 ospitati su server CORS-compliant funzionano sempre.
- **Autoplay policy**: l'`AudioContext` viene inizializzato al primo click/interazione utente (`initAudio()`), rispettando le policy del browser Chromium embedded in FiveM.
- **`playNearbyMusic` non passa per il grafo Web Audio**: i giocatori vicini sentono la musica broadcast tramite un `HTMLAudioElement` standalone, non connesso al masterGain. Il volume è controllato da `audio.volume` direttamente.
