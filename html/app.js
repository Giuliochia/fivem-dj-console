'use strict';

// ============================================================
// Audio Engine
// ============================================================
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let ctx = null;
let masterGain = null;
let crossfadeValue = 0.5;   // 0 = full A, 1 = full B
let broadcastActive = false;
let broadcastInterval = null;
let vuRafId = null;

const activeFX = { echo: false, reverb: false, flanger: false, filter: false };

function makeDeck() {
    return {
        audio: null, source: null, gainNode: null,
        eq: null, fxChain: null,
        analyser: null, analyserData: null,
        bpmAnalyser: null, bpmData: null,
        playing: false, cueTime: 0, currentUrl: null, currentBPM: null,
        loopActive: false, loopStart: 0, loopEnd: 0,
        cuePreview: false,
        bpmHistory: [], lastBeatTime: 0, lastEnergy: 0,
    };
}
const decks = { A: makeDeck(), B: makeDeck() };

// ============================================================
// Preferences (localStorage)
// ============================================================
function savePref(key, val) {
    try { localStorage.setItem(`dj_${key}`, val); } catch {}
}
function loadPref(key, def) {
    try {
        const v = localStorage.getItem(`dj_${key}`);
        return v !== null ? parseFloat(v) : def;
    } catch { return def; }
}

// ============================================================
// Audio init
// ============================================================
function initAudio() {
    if (ctx) return;
    ctx = new AudioCtx();
    masterGain = ctx.createGain();
    masterGain.gain.value = loadPref('masterVol', 80) / 100;
    masterGain.connect(ctx.destination);
}

// ============================================================
// Deck chain: gainNode → EQ (lo→mid→hi) → FX → analyser → masterGain
//                                              ↘ bpmAnalyser
// ============================================================
function teardownDeckChain(deck) {
    const d = decks[deck];
    if (d.fxChain) {
        try { d.fxChain.flanger.lfo.stop(); } catch {}
        try { d.fxChain.flanger.feedback.disconnect(); } catch {}
        try { d.fxChain.input.disconnect(); } catch {}
        try { d.fxChain.output.disconnect(); } catch {}
    }
    // Disconnette l'analyser da masterGain — senza questo ogni rebuild
    // aggiunge un nodo in più al grafo audio senza mai rimuovere il precedente
    if (d.analyser) { try { d.analyser.disconnect(); } catch {} }
    if (d.gainNode)  { try { d.gainNode.disconnect();  } catch {} }
    d.fxChain = null;
    d.gainNode = null;
    d.eq = null;
    d.analyser = null;
    d.analyserData = null;
    d.bpmAnalyser = null;
    d.bpmData = null;
}

function createDeckChain(deck) {
    const d = decks[deck];
    teardownDeckChain(deck);

    const gainNode = ctx.createGain();
    gainNode.gain.value = loadPref(`vol${deck}`, 80) / 100;

    // EQ – 3 biquad filters in serie
    const hiFilter = ctx.createBiquadFilter();
    hiFilter.type = 'highshelf';
    hiFilter.frequency.value = 8000;

    const midFilter = ctx.createBiquadFilter();
    midFilter.type = 'peaking';
    midFilter.frequency.value = 1000;
    midFilter.Q.value = 1;

    const loFilter = ctx.createBiquadFilter();
    loFilter.type = 'lowshelf';
    loFilter.frequency.value = 200;

    // FX chain
    const fxChain = buildFXChain();

    // VU analyser
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;

    // BPM analyser (separato, no output audio)
    const bpmAnalyser = ctx.createAnalyser();
    bpmAnalyser.fftSize = 1024;
    bpmAnalyser.smoothingTimeConstant = 0.3;

    // Connessioni
    gainNode.connect(loFilter);
    loFilter.connect(midFilter);
    midFilter.connect(hiFilter);
    hiFilter.connect(fxChain.input);
    fxChain.output.connect(analyser);
    fxChain.output.connect(bpmAnalyser);
    analyser.connect(masterGain);

    d.gainNode = gainNode;
    d.eq = { hi: hiFilter, mid: midFilter, lo: loFilter };
    d.fxChain = fxChain;
    d.analyser = analyser;
    d.analyserData = new Uint8Array(analyser.frequencyBinCount);
    d.bpmAnalyser = bpmAnalyser;
    d.bpmData = new Uint8Array(bpmAnalyser.frequencyBinCount);

    // Ripristina valori knob EQ attuali
    ['hi', 'mid', 'lo'].forEach(band => {
        const knob = document.getElementById(`eq-${band}-${deck.toLowerCase()}`);
        if (knob) applyKnob(knob.id, parseInt(knob.dataset.value || 75));
    });

    // Ripristina FX attivi
    Object.entries(activeFX).forEach(([name, active]) => {
        if (active) applyFXToDeck(name, true, deck);
    });

    // Applica crossfade corretto
    const volEl = document.getElementById(`vol-${deck.toLowerCase()}`);
    updateDeckVolume(deck, parseInt(volEl.value));
}

// ============================================================
// FX Chain builder
// Architettura dry/wet parallela:
//   input → dryGain   ──────────────────────────────┐
//         → echoDelay → echoWet                     │
//         → reverbNode → reverbWet                  ├→ output
//         → flangerDelay → flangerWet               │
//         → filterNode → filterWet                  │
//                                                   ┘
// ============================================================
function buildFXChain() {
    const input  = ctx.createGain();
    const output = ctx.createGain();

    // Dry path
    const dryGain = ctx.createGain();
    dryGain.gain.value = 1.0;
    input.connect(dryGain);
    dryGain.connect(output);

    // ---- ECHO ----
    const echoDelay = ctx.createDelay(2.0);
    echoDelay.delayTime.value = 0.35;
    const echoFeedback = ctx.createGain();
    echoFeedback.gain.value = 0.4;
    const echoWet = ctx.createGain();
    echoWet.gain.value = 0;
    input.connect(echoDelay);
    echoDelay.connect(echoFeedback);
    echoFeedback.connect(echoDelay);    // feedback loop
    echoDelay.connect(echoWet);
    echoWet.connect(output);

    // ---- REVERB ----
    const reverbNode = ctx.createConvolver();
    reverbNode.buffer = buildImpulseResponse(2.5, 2.0);
    const reverbWet = ctx.createGain();
    reverbWet.gain.value = 0;
    input.connect(reverbNode);
    reverbNode.connect(reverbWet);
    reverbWet.connect(output);

    // ---- FLANGER ----
    // Delay corto (1-5ms) modulato da un LFO sinusoidale a bassa frequenza
    const flangerDelay = ctx.createDelay(0.05);
    flangerDelay.delayTime.value = 0.003;
    const flangerFeedback = ctx.createGain();
    flangerFeedback.gain.value = 0.6;
    const flangerWet = ctx.createGain();
    flangerWet.gain.value = 0;
    const flangerLFO = ctx.createOscillator();
    flangerLFO.type = 'sine';
    flangerLFO.frequency.value = 0.3;   // Hz
    const flangerLFOGain = ctx.createGain();
    flangerLFOGain.gain.value = 0.002;  // ampiezza delay in secondi
    flangerLFO.connect(flangerLFOGain);
    flangerLFOGain.connect(flangerDelay.delayTime);
    flangerLFO.start();
    input.connect(flangerDelay);
    flangerDelay.connect(flangerFeedback);
    flangerFeedback.connect(flangerDelay);
    flangerDelay.connect(flangerWet);
    flangerWet.connect(output);

    // ---- FILTER ----
    // Lowpass con risonanza: sostituisce il dry quando attivo
    const filterNode = ctx.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.frequency.value = 800;
    filterNode.Q.value = 8;
    const filterWet = ctx.createGain();
    filterWet.gain.value = 0;
    input.connect(filterNode);
    filterNode.connect(filterWet);
    filterWet.connect(output);

    return {
        input, output, dryGain,
        echo:    { delay: echoDelay, feedback: echoFeedback, wet: echoWet },
        reverb:  { node: reverbNode, wet: reverbWet },
        flanger: { delay: flangerDelay, feedback: flangerFeedback, wet: flangerWet, lfo: flangerLFO },
        filter:  { node: filterNode, wet: filterWet },
    };
}

// Genera una risposta all'impulso sintetica per il reverb
function buildImpulseResponse(duration, decay) {
    const sr     = ctx.sampleRate;
    const length = Math.floor(sr * duration);
    const buf    = ctx.createBuffer(2, length, sr);
    for (let c = 0; c < 2; c++) {
        const ch = buf.getChannelData(c);
        for (let i = 0; i < length; i++) {
            ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
    }
    return buf;
}

// Ricalcola il dry gain considerando tutti gli FX attivi
function recomputeDryGain(deck) {
    const fx = decks[deck].fxChain;
    if (!fx || !ctx) return;
    let dry = 1.0;
    if (activeFX.filter) {
        dry = 0;
    } else {
        const depth = getFXDepth();
        if (activeFX.echo)   dry -= depth * 0.3;
        if (activeFX.reverb) dry -= depth * 0.2;
    }
    fx.dryGain.gain.setTargetAtTime(Math.max(0, dry), ctx.currentTime, 0.05);
}

function getFXDepth() {
    const raw = parseInt(document.getElementById('fx-depth').dataset.value || 75);
    return raw / 150;   // 0..1
}

function toggleFX(name) {
    const btn = document.getElementById(`fx-${name}`);
    btn.classList.toggle('active');
    activeFX[name] = btn.classList.contains('active');
    ['A', 'B'].forEach(deck => applyFXToDeck(name, activeFX[name], deck));
}

function applyFXToDeck(name, active, deck) {
    const fx = decks[deck].fxChain;
    if (!fx || !ctx) return;
    const depth = getFXDepth();
    const t     = ctx.currentTime;

    if (name === 'echo') {
        fx.echo.wet.gain.setTargetAtTime(active ? depth * 0.7 : 0, t, 0.05);
    } else if (name === 'reverb') {
        fx.reverb.wet.gain.setTargetAtTime(active ? depth * 0.6 : 0, t, 0.05);
    } else if (name === 'flanger') {
        fx.flanger.wet.gain.setTargetAtTime(active ? depth : 0, t, 0.05);
    } else if (name === 'filter') {
        if (active) {
            const freq = 200 + depth * 7800;
            fx.filter.node.frequency.setTargetAtTime(freq, t, 0.05);
            fx.filter.wet.gain.setTargetAtTime(1.0, t, 0.05);
        } else {
            fx.filter.wet.gain.setTargetAtTime(0, t, 0.05);
        }
    }
    recomputeDryGain(deck);
}

// Chiamata quando il knob DEPTH cambia
function onFXDepthChange() {
    if (!ctx) return;
    // applyFXToDeck gestisce già freq del filter internamente
    Object.entries(activeFX).forEach(([name, active]) => {
        if (active) ['A', 'B'].forEach(deck => applyFXToDeck(name, true, deck));
    });
}

// ============================================================
// Deck logic
// ============================================================
function togglePlay(deck) {
    const d   = decks[deck];
    const url = document.getElementById(`url-${deck.toLowerCase()}`).value.trim();
    if (!url) { showToast('Inserisci un URL!'); return; }
    try { new URL(url); } catch { showToast('URL non valido!'); return; }
    initAudio();
    if (d.playing) { pauseDeck(deck); } else { playDeck(deck, url); }
}

function playDeck(deck, url) {
    const d = decks[deck];

    // Fix 13: al cambio URL ricrea completamente elemento audio e source node
    if (d.currentUrl !== url) {
        if (d.source) { try { d.source.disconnect(); } catch {} d.source = null; }
        d.audio      = new Audio();
        d.audio.crossOrigin = 'anonymous';
        d.audio.src  = url;
        d.currentUrl = url;
        setTrackName(deck, extractName(url));
        addToHistory(deck, url);
        // Reset BPM al cambio traccia
        d.bpmHistory  = [];
        d.currentBPM  = null;
        d.lastBeatTime = 0;
        document.getElementById(`bpm-${deck.toLowerCase()}`).textContent = '--';
    }

    createDeckChain(deck);

    if (!d.source) {
        d.source = ctx.createMediaElementSource(d.audio);
    }
    d.source.connect(d.gainNode);

    d.audio.play().catch(e => showToast('Errore: ' + e.message));
    d.playing = true;

    updateDeckUI(deck, true);
    postNUI('playDeck', { deck, url, volume: d.gainNode.gain.value });
    startRaf();

    // Fix 8: ri-broadcast se era attivo
    if (broadcastActive) sendBroadcast();
}

function pauseDeck(deck) {
    const d = decks[deck];
    if (d.audio) d.audio.pause();
    d.playing = false;
    updateDeckUI(deck, false);
}

function stopDeck(deck) {
    const d = decks[deck];
    if (d.audio) { d.audio.pause(); d.audio.currentTime = 0; }
    d.playing    = false;
    d.cueTime    = 0;
    d.loopActive = false;

    updateDeckUI(deck, false);
    document.getElementById(`time-${deck.toLowerCase()}`).textContent  = '0:00';
    document.getElementById(`track-name-${deck.toLowerCase()}`).textContent = 'NO TRACK';
    document.getElementById(`bpm-${deck.toLowerCase()}`).textContent   = '--';

    postNUI('stopDeck', { deck });
}

function updateDeckUI(deck, playing) {
    const dl      = deck.toLowerCase();
    const playBtn = document.getElementById(`play-${dl}`);
    const vinyl   = document.getElementById(`turntable-${dl}`).querySelector('.vinyl');
    const tonearm = document.getElementById(`tonearm-${dl}`);
    if (playing) {
        playBtn.classList.add('active');
        playBtn.textContent = '⏸ PAUSE';
        vinyl.classList.add('spinning');
        tonearm.style.transform = 'rotate(35deg)';
    } else {
        playBtn.classList.remove('active');
        playBtn.textContent = '▶ PLAY';
        vinyl.classList.remove('spinning');
        tonearm.style.transform = 'rotate(20deg)';
    }
}

// ============================================================
// Fix 4 – Cue point con preview mousedown/mouseup
// Comportamento:
//   • Se in play → salva posizione come cueTime (flash visivo)
//   • Se in pausa → jump a cueTime e preview finché il tasto è premuto
// ============================================================
function setupCueButtons() {
    ['A', 'B'].forEach(deck => {
        const btn = document.querySelector(`.deck-${deck.toLowerCase()} .btn-cue`);
        btn.removeAttribute('onclick');

        btn.addEventListener('mousedown', () => {
            const d = decks[deck];
            if (d.playing) {
                // Salva il cue point
                d.cueTime = d.audio ? d.audio.currentTime : 0;
                btn.classList.add('active');
                setTimeout(() => btn.classList.remove('active'), 300);
            } else if (d.audio && d.currentUrl) {
                // Avvia preview dal cue point
                d.audio.currentTime = d.cueTime;
                d.cuePreview = true;
                d.audio.play().catch(() => {});
                d.playing = true;
                updateDeckUI(deck, true);
                startRaf();
                btn.classList.add('active');
            }
        });

        const stopPreview = () => {
            const d = decks[deck];
            if (d.cuePreview) {
                d.cuePreview = false;
                pauseDeck(deck);
                if (d.audio) d.audio.currentTime = d.cueTime;
                btn.classList.remove('active');
            }
        };
        btn.addEventListener('mouseup',    stopPreview);
        btn.addEventListener('mouseleave', stopPreview);
    });
}

// ============================================================
// Fix 5 – Volume & Crossfader con curva equal-power
// A: cos(cf·π/2)  B: sin(cf·π/2)
// Al centro entrambi a -3dB, potenza combinata = 1.0
// ============================================================
function updateMasterVolume(val) {
    if (masterGain) masterGain.gain.value = val / 100;
    savePref('masterVol', val);
    postNUI('setVolume', { type: 'master', value: val });
}

function updateDeckVolume(deck, val) {
    savePref(`vol${deck}`, val);
    const d = decks[deck];
    if (!d.gainNode) return;
    const base   = val / 100;
    const cf     = crossfadeValue;
    const cfGain = deck === 'A'
        ? Math.cos(cf * Math.PI / 2)
        : Math.sin(cf * Math.PI / 2);
    d.gainNode.gain.value = base * cfGain;
}

function updateCrossfader(val) {
    crossfadeValue = val / 100;
    savePref('crossfader', val);
    const pos = val < 40 ? 'DECK A' : val > 60 ? 'DECK B' : 'CENTER';
    document.getElementById('cf-pos').textContent = pos;
    updateDeckVolume('A', parseInt(document.getElementById('vol-a').value));
    updateDeckVolume('B', parseInt(document.getElementById('vol-b').value));
}

function updatePitch(deck, val) {
    const f = parseFloat(val);
    document.getElementById(`pitch-val-${deck.toLowerCase()}`).textContent =
        `${f > 0 ? '+' : ''}${f.toFixed(1)}%`;
    const d = decks[deck];
    if (d.audio) d.audio.playbackRate = 1 + f / 100;
}

// ============================================================
// EQ Knobs (drag)
// ============================================================
document.querySelectorAll('.knob').forEach(knob => {
    let startY, startVal;
    knob.addEventListener('mousedown', e => {
        startY   = e.clientY;
        startVal = parseInt(knob.dataset.value || 75);
        e.preventDefault();
        const onMove = ev => {
            const newVal = Math.max(0, Math.min(150, startVal + (startY - ev.clientY)));
            knob.dataset.value = newVal;
            const deg = (newVal / 150) * 270 - 135;
            knob.style.transform = `rotate(${deg}deg)`;
            applyKnob(knob.id, newVal);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup',   onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
    });
    const initVal = parseInt(knob.dataset.value || 75);
    knob.style.transform = `rotate(${(initVal / 150) * 270 - 135}deg)`;
});

function applyKnob(id, val) {
    if (id === 'fx-depth') {
        onFXDepthChange();
        return;
    }
    // Formato: eq-{band}-{deck}  es. eq-hi-a
    const parts = id.split('-');
    const band  = parts[1];
    const deck  = parts[2] ? parts[2].toUpperCase() : null;
    if (!deck || !decks[deck] || !decks[deck].eq) return;
    const gain = ((val - 75) / 75) * 12;   // -12dB … +12dB
    const eq = decks[deck].eq;
    if (band === 'hi')  eq.hi.gain.value  = gain;
    else if (band === 'mid') eq.mid.gain.value = gain;
    else if (band === 'lo')  eq.lo.gain.value  = gain;
}

// ============================================================
// Fix 1 – Loop audio reale
// I bottoni selezionano la durata in misure (bars).
// Il RAF controlla il currentTime e fa il jump al loopStart.
// ============================================================
let activeLoopBars = 0;

function setLoop(bars, btn) {
    // Toggle: clicca lo stesso bottone per disattivare
    if (activeLoopBars === bars) {
        activeLoopBars = 0;
        document.querySelectorAll('.loop-btn').forEach(b => b.classList.remove('active'));
        ['A', 'B'].forEach(deck => { decks[deck].loopActive = false; });
        return;
    }

    activeLoopBars = bars;
    document.querySelectorAll('.loop-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    ['A', 'B'].forEach(deck => {
        const d = decks[deck];
        if (!d.playing || !d.audio) return;
        const bpm         = d.currentBPM || 120;
        const beatLen     = 60 / bpm;
        // 1 misura = 4 beats in 4/4
        const loopDuration = bars * 4 * beatLen;
        d.loopActive  = true;
        d.loopStart   = d.audio.currentTime;
        d.loopEnd     = d.loopStart + loopDuration;
    });
}

// Chiamato ogni frame RAF
function checkLoop(deck) {
    const d = decks[deck];
    if (!d.loopActive || !d.playing || !d.audio) return;
    if (d.audio.currentTime >= d.loopEnd) {
        d.audio.currentTime = d.loopStart;
    }
}

// ============================================================
// Fix 8 – Broadcast con heartbeat periodico
// ============================================================
function toggleBroadcast() {
    broadcastActive = !broadcastActive;
    const btn    = document.getElementById('broadcast-btn');
    const status = document.getElementById('broadcast-status');
    btn.classList.toggle('active', broadcastActive);
    status.textContent = broadcastActive ? 'ON AIR' : 'OFF';
    status.classList.toggle('on', broadcastActive);

    if (broadcastActive) {
        sendBroadcast();
        // Heartbeat ogni 30s per mantenere i giocatori vicini sincronizzati
        broadcastInterval = setInterval(sendBroadcast, 30000);
    } else {
        if (broadcastInterval) { clearInterval(broadcastInterval); broadcastInterval = null; }
    }
}

function sendBroadcast() {
    const url = decks.A.playing ? decks.A.currentUrl
              : decks.B.playing ? decks.B.currentUrl
              : null;
    if (!url) return;
    const vol = parseInt(document.getElementById('master-vol').value) / 100;
    postNUI('broadcastMusic', { url, volume: vol });
}

// ============================================================
// Fix 12 – RAF loop unificato (VU + BPM + Timer + Loop check)
// Un solo requestAnimationFrame gestisce tutto, attivo solo
// quando almeno un deck è in riproduzione.
// ============================================================
function startRaf() {
    if (vuRafId) return;
    function loop() {
        animateVU('vu-a', decks.A);
        animateVU('vu-b', decks.B);
        detectBPM('A');
        detectBPM('B');
        updateTimerDisplay('A');
        updateTimerDisplay('B');
        checkLoop('A');
        checkLoop('B');
        if (decks.A.playing || decks.B.playing) {
            vuRafId = requestAnimationFrame(loop);
        } else {
            vuRafId = null;
        }
    }
    vuRafId = requestAnimationFrame(loop);
}

// ============================================================
// Fix 7 – VU Meter reale via AnalyserNode
// ============================================================
function animateVU(id, deck) {
    const bars  = document.getElementById(id).querySelectorAll('.vu-bar');
    let level   = 0;
    if (deck.playing && deck.analyser && deck.analyserData) {
        deck.analyser.getByteFrequencyData(deck.analyserData);
        const sum = deck.analyserData.reduce((a, b) => a + b, 0);
        level = sum / (deck.analyserData.length * 255);
    }
    const filled = Math.round(level * bars.length);
    bars.forEach((bar, i) => {
        bar.classList.remove('active-green', 'active-yellow', 'active-red');
        if (i < filled) {
            if      (i < 4) bar.classList.add('active-green');
            else if (i < 6) bar.classList.add('active-yellow');
            else            bar.classList.add('active-red');
        }
    });
}

// ============================================================
// Fix 3 – BPM Detection (energy-based, banda bassa 60-200Hz)
// ============================================================
function detectBPM(deck) {
    const d = decks[deck];
    if (!d.playing || !d.bpmAnalyser || !d.bpmData || !ctx) return;

    d.bpmAnalyser.getByteFrequencyData(d.bpmData);

    // fftSize=1024, sampleRate~44100 → binWidth≈43Hz
    // bin 1≈43Hz, bin 5≈215Hz → fascia bassa 60-200Hz
    let energy = 0;
    for (let i = 1; i <= 5; i++) energy += d.bpmData[i];
    energy /= 5;

    const now       = ctx.currentTime;
    const threshold = 130;  // su 255

    if (energy > threshold && d.lastEnergy <= threshold) {
        // Beat rilevato
        if (d.lastBeatTime > 0) {
            const interval = now - d.lastBeatTime;
            // Intervallo valido: 30–200 BPM (0.3s – 2.0s)
            if (interval > 0.3 && interval < 2.0) {
                d.bpmHistory.push(interval);
                if (d.bpmHistory.length > 12) d.bpmHistory.shift();
                if (d.bpmHistory.length >= 4) {
                    const avg = d.bpmHistory.reduce((a, b) => a + b, 0) / d.bpmHistory.length;
                    const bpm = Math.round(60 / avg);
                    if (bpm >= 60 && bpm <= 200) {
                        d.currentBPM = bpm;
                        document.getElementById(`bpm-${deck.toLowerCase()}`).textContent = bpm;
                    }
                }
            }
        }
        d.lastBeatTime = now;
    }
    d.lastEnergy = energy;
}

// ============================================================
// Timer display (integrato nel RAF)
// ============================================================
function updateTimerDisplay(deck) {
    const d = decks[deck];
    if (!d.playing || !d.audio) return;
    const t = d.audio.currentTime;
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    document.getElementById(`time-${deck.toLowerCase()}`).textContent = `${m}:${s}`;
}

// ============================================================
// Fix 6 – URL History (localStorage + datalist)
// ============================================================
function addToHistory(deck, url) {
    const key = `dj_history_${deck}`;
    let history = [];
    try { history = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
    history = [url, ...history.filter(u => u !== url)].slice(0, 10);
    try { localStorage.setItem(key, JSON.stringify(history)); } catch {}
    refreshHistoryDatalist(deck, history);
}

function refreshHistoryDatalist(deck, history) {
    const dl = document.getElementById(`history-${deck.toLowerCase()}`);
    if (!dl) return;
    dl.innerHTML = history.map(u => `<option value="${escHtml(u)}">`).join('');
}

function loadHistory(deck) {
    let history = [];
    try { history = JSON.parse(localStorage.getItem(`dj_history_${deck}`) || '[]'); } catch {}
    refreshHistoryDatalist(deck, history);
}

// ============================================================
// Fix 10 – Ripristino preferenze al caricamento
// ============================================================
function restorePrefs() {
    const masterVol = loadPref('masterVol', 80);
    const volA      = loadPref('volA',      80);
    const volB      = loadPref('volB',      80);
    const cf        = loadPref('crossfader', 50);

    document.getElementById('master-vol').value = masterVol;
    document.getElementById('vol-a').value      = volA;
    document.getElementById('vol-b').value      = volB;
    document.getElementById('crossfader').value = cf;

    crossfadeValue = cf / 100;
    document.getElementById('cf-pos').textContent =
        cf < 40 ? 'DECK A' : cf > 60 ? 'DECK B' : 'CENTER';
}

// ============================================================
// UI open/close
// ============================================================
function openConsole() {
    document.getElementById('dj-console').classList.remove('hidden');
    if (ctx && ctx.state === 'suspended') ctx.resume();
}

function closeConsole() {
    document.getElementById('dj-console').classList.add('hidden');
    if (ctx && ctx.state === 'running') ctx.suspend();
    postNUI('close', {});
}

// ============================================================
// NUI Messages da Lua
// ============================================================
window.addEventListener('message', e => {
    const { action } = e.data;
    if      (action === 'open')            openConsole();
    else if (action === 'close')           closeConsole();
    else if (action === 'playNearbyMusic') playNearbyMusic(e.data.url, e.data.volume);
});

function playNearbyMusic(url, volume) {
    try { new URL(url); } catch { return; }
    initAudio();
    const audio = new Audio();
    audio.crossOrigin = 'anonymous';
    audio.src    = url;
    audio.volume = Math.max(0, Math.min(1, volume || 0.5));
    audio.play().catch(() => {});
}

// ============================================================
// Helpers
// ============================================================
function postNUI(action, data) {
    fetch(`https://dj_console/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).catch(() => {});
}

function setTrackName(deck, name) {
    document.getElementById(`track-name-${deck.toLowerCase()}`).textContent = name;
}

function extractName(url) {
    try {
        const parts = new URL(url).pathname.split('/');
        const raw   = parts[parts.length - 1] || url.substring(0, 24);
        return decodeURIComponent(raw).substring(0, 24) || 'STREAM';
    } catch { return url.substring(0, 24); }
}

function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

let toastTimeout = null;
function showToast(msg) {
    let t = document.getElementById('toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'toast';
        Object.assign(t.style, {
            position: 'fixed', bottom: '20px', left: '50%',
            transform: 'translateX(-50%)',
            background: '#1a1a2e', border: '1px solid #00c8ff', color: '#00c8ff',
            padding: '8px 18px', borderRadius: '8px', fontSize: '12px',
            fontFamily: 'Share Tech Mono, monospace', zIndex: '9999',
            boxShadow: '0 0 20px #00c8ff44', transition: 'opacity 0.3s',
        });
        document.body.appendChild(t);
    }
    t.textContent    = msg;
    t.style.opacity  = '1';
    t.style.display  = 'block';
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        t.style.opacity = '0';
        setTimeout(() => { t.style.display = 'none'; }, 300);
    }, 2500);
}

// ============================================================
// Keyboard shortcuts
// ============================================================
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeConsole();
});

// Fix 7 – Enter nell'input URL avvia il play
document.getElementById('url-a').addEventListener('keydown', e => { if (e.key === 'Enter') togglePlay('A'); });
document.getElementById('url-b').addEventListener('keydown', e => { if (e.key === 'Enter') togglePlay('B'); });

// ============================================================
// Bootstrap
// ============================================================
setupCueButtons();
restorePrefs();
loadHistory('A');
loadHistory('B');
