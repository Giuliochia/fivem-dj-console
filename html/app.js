'use strict';

// ============================================================
// Audio Engine
// ============================================================
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let ctx = null;
let masterGain = null;
let crossfadeValue = 0.5;   // 0 = full A, 1 = full B
let broadcastActive = true;   // sempre attivo: il locale trasmette sempre
let broadcastInterval = null;
let vuRafId = null;

const activeFX = { echo: false, reverb: false, flanger: false, filter: false, phaser: false, chorus: false, distort: false, gate: false };

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
        webAudioActive: false,
        isYouTube: false,
        ytPlayer: null,
        hotCues: new Array(8).fill(null),
    };
}

// ============================================================
// YouTube IFrame API
// ============================================================
let ytApiReady = false;
const ytPendingCallbacks = [];

window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    ytPendingCallbacks.forEach(cb => cb());
    ytPendingCallbacks.length = 0;
};

function ensureYTApi(cb) {
    if (ytApiReady) { cb(); } else { ytPendingCallbacks.push(cb); }
}

function isYouTubeUrl(url) {
    return /(?:youtube\.com\/(?:watch|shorts|embed)|youtu\.be\/)/.test(url);
}

function extractYouTubeId(url) {
    // youtube.com/watch?v=ID  |  youtu.be/ID  |  youtube.com/shorts/ID
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
}

function applyYTVolume(deck) {
    const d = decks[deck];
    if (!d.ytPlayer || typeof d.ytPlayer.setVolume !== 'function') return;
    const volEl    = document.getElementById(`vol-${deck.toLowerCase()}`);
    const masterEl = document.getElementById('master-vol');
    const base     = volEl    ? parseInt(volEl.value)    / 100 : 0.8;
    const master   = masterEl ? parseInt(masterEl.value) / 100 : 0.8;
    const cf       = crossfadeValue;
    const cfGain   = deck === 'A'
        ? Math.cos(cf * Math.PI / 2)
        : Math.sin(cf * Math.PI / 2);
    const vol = Math.max(0, Math.min(100, Math.round(base * cfGain * master * 100)));
    d.ytPlayer.setVolume(vol);
}

function playYouTube(deck, videoId) {
    const d = decks[deck];
    const containerId = `yt-player-${deck.toLowerCase()}`;

    ensureYTApi(() => {
        if (d.ytPlayer && typeof d.ytPlayer.loadVideoById === 'function') {
            // Player già esistente: carica nuovo video
            d.ytPlayer.loadVideoById(videoId);
            applyYTVolume(deck);
        } else {
            d.ytPlayer = new YT.Player(containerId, {
                height: '1', width: '1',
                videoId,
                playerVars: { autoplay: 1, controls: 0, origin: location.origin },
                events: {
                    onReady(e) {
                        applyYTVolume(deck);
                        e.target.playVideo();
                    },
                    onStateChange(e) {
                        // YT.PlayerState.ENDED = 0
                        if (e.data === 0 && d.loopActive) {
                            e.target.seekTo(d.loopStart, true);
                            e.target.playVideo();
                        }
                    },
                },
            });
        }
        d.isYouTube      = true;
        d.playing        = true;
        d.webAudioActive = false;
        setYTMode(deck, true);
        updateDeckUI(deck, true);
        startRaf();
        if (broadcastActive) sendBroadcast();
    });
}

// Attiva/disattiva la modalità visiva "YT MODE" sul deck:
// - mostra badge nel nome traccia
// - EQ e FX non applicabili → la sezione EQ viene dimmed
function setYTMode(deck, active) {
    const dl      = deck.toLowerCase();
    const eqSec   = document.querySelector(`.deck-${dl} .eq-section`);
    const nameBadge = document.getElementById(`track-name-${dl}`);
    if (active) {
        if (eqSec) { eqSec.style.opacity = '0.3'; eqSec.style.pointerEvents = 'none'; eqSec.title = 'EQ non disponibile in modalità YouTube'; }
    } else {
        if (eqSec) { eqSec.style.opacity = ''; eqSec.style.pointerEvents = ''; eqSec.title = ''; }
    }
}

function pauseYouTube(deck) {
    const d = decks[deck];
    if (d.ytPlayer && typeof d.ytPlayer.pauseVideo === 'function') d.ytPlayer.pauseVideo();
    d.playing = false;
    updateDeckUI(deck, false);
}

function stopYouTube(deck) {
    const d = decks[deck];
    if (d.ytPlayer && typeof d.ytPlayer.stopVideo === 'function') d.ytPlayer.stopVideo();
    d.playing    = false;
    d.isYouTube  = false;
    d.cueTime    = 0;
    d.loopActive = false;
    setYTMode(deck, false);
    updateDeckUI(deck, false);
    document.getElementById(`time-${deck.toLowerCase()}`).textContent  = '0:00';
    document.getElementById(`track-name-${deck.toLowerCase()}`).textContent = 'NO TRACK';
    document.getElementById(`bpm-${deck.toLowerCase()}`).textContent   = '--';
    postNUI('stopDeck', { deck });
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
        try { d.fxChain.phaser?.lfo.stop(); } catch {}
        try { d.fxChain.chorus?.lfo.stop(); } catch {}
        try { d.fxChain.gate?.lfo.stop(); } catch {}
        try { d.fxChain.gate?.dc.stop(); } catch {}
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
// Distortion curve helper (module scope so applyFXToDeck can use it)
function makeDistCurve(amount) {
    const n = 256, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const x = i * 2 / n - 1;
        c[i] = (Math.PI + amount) * x / (Math.PI + amount * Math.abs(x));
    }
    return c;
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

    // ---- PHASER ----
    const phaserWet = ctx.createGain(); phaserWet.gain.value = 0;
    const phaserFilters = [350, 700, 1400, 2800].map(f => {
        const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.frequency.value = f; return ap;
    });
    phaserFilters.reduce((prev, curr) => { prev.connect(curr); return curr; }, input);
    phaserFilters[phaserFilters.length - 1].connect(phaserWet);
    phaserWet.connect(output);
    const phaserLFO = ctx.createOscillator(); phaserLFO.type = 'sine'; phaserLFO.frequency.value = 0.5;
    const phaserLFOGain = ctx.createGain(); phaserLFOGain.gain.value = 600;
    phaserLFO.connect(phaserLFOGain);
    phaserFilters.forEach(ap => phaserLFOGain.connect(ap.frequency));
    phaserLFO.start();

    // ---- CHORUS ----
    const chorusDelay = ctx.createDelay(0.1);
    chorusDelay.delayTime.value = 0.025;
    const chorusWet = ctx.createGain(); chorusWet.gain.value = 0;
    const chorusLFO = ctx.createOscillator(); chorusLFO.type = 'sine'; chorusLFO.frequency.value = 0.8;
    const chorusLFOGain = ctx.createGain(); chorusLFOGain.gain.value = 0.006;
    chorusLFO.connect(chorusLFOGain); chorusLFOGain.connect(chorusDelay.delayTime);
    chorusLFO.start();
    input.connect(chorusDelay); chorusDelay.connect(chorusWet); chorusWet.connect(output);

    // ---- DISTORT ----
    const distorter = ctx.createWaveShaper();
    distorter.curve = makeDistCurve(200);
    distorter.oversample = '4x';
    const distWet = ctx.createGain(); distWet.gain.value = 0;
    input.connect(distorter); distorter.connect(distWet); distWet.connect(output);

    // ---- GATE (stutter) ----
    const gateGain = ctx.createGain(); gateGain.gain.value = 0;
    const gateWet  = ctx.createGain(); gateWet.gain.value  = 0;
    const gateLFO  = ctx.createOscillator(); gateLFO.type = 'square'; gateLFO.frequency.value = 8;
    const gateDC   = ctx.createConstantSource(); gateDC.offset.value = 0.5;
    const gateScale = ctx.createGain(); gateScale.gain.value = 0.5;
    gateLFO.connect(gateScale); gateScale.connect(gateGain.gain);
    gateDC.connect(gateGain.gain);
    gateDC.start(); gateLFO.start();
    input.connect(gateGain); gateGain.connect(gateWet); gateWet.connect(output);

    return {
        input, output, dryGain,
        echo:    { delay: echoDelay, feedback: echoFeedback, wet: echoWet },
        reverb:  { node: reverbNode, wet: reverbWet },
        flanger: { delay: flangerDelay, feedback: flangerFeedback, wet: flangerWet, lfo: flangerLFO },
        filter:  { node: filterNode, wet: filterWet },
        phaser:  { filters: phaserFilters, wet: phaserWet, lfo: phaserLFO },
        chorus:  { delay: chorusDelay, wet: chorusWet, lfo: chorusLFO },
        distort: { node: distorter, wet: distWet },
        gate:    { gain: gateGain, wet: gateWet, lfo: gateLFO, dc: gateDC },
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
    if (activeFX.filter || activeFX.gate) {
        dry = 0;
    } else {
        const depth = getFXDepth();
        if (activeFX.echo)    dry -= depth * 0.3;
        if (activeFX.reverb)  dry -= depth * 0.2;
        if (activeFX.distort) dry -= depth * 0.5;
    }
    fx.dryGain.gain.setTargetAtTime(Math.max(0, dry), ctx.currentTime, 0.05);
}

function getFXDepth() {
    const raw = parseInt(document.getElementById('fx-depth').dataset.value || 75);
    return raw / 150;   // 0..1
}

function toggleFX(name) {
    initAudio();
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
    } else if (name === 'phaser') {
        fx.phaser.wet.gain.setTargetAtTime(active ? depth * 0.8 : 0, t, 0.05);
    } else if (name === 'chorus') {
        fx.chorus.wet.gain.setTargetAtTime(active ? depth * 0.7 : 0, t, 0.05);
    } else if (name === 'distort') {
        fx.distort.node.curve = makeDistCurve(50 + depth * 350);
        fx.distort.wet.gain.setTargetAtTime(active ? Math.min(depth, 0.9) : 0, t, 0.05);
    } else if (name === 'gate') {
        fx.gate.lfo.frequency.setTargetAtTime(3 + depth * 13, t, 0.05);
        fx.gate.wet.gain.setTargetAtTime(active ? 1.0 : 0, t, 0.05);
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

    if (isYouTubeUrl(url)) {
        const videoId = extractYouTubeId(url);
        if (!videoId) { showToast('ID YouTube non trovato!'); return; }
        if (d.playing && d.isYouTube) {
            pauseYouTube(deck);
        } else if (d.isYouTube && d.ytPlayer && d.currentUrl === url && !d.playing) {
            // Resume dalla pausa senza ricominciare dall'inizio
            d.ytPlayer.playVideo();
            d.playing = true;
            updateDeckUI(deck, true);
            startRaf();
        } else {
            if (d.currentUrl !== url) {
                d.currentUrl = url;
                setTrackName(deck, 'YouTube', videoId);
                addToHistory(deck, url);
                d.bpmHistory = [];
                d.currentBPM = null;
            }
            playYouTube(deck, videoId);
        }
        return;
    }

    // URL non-YouTube: flusso audio normale
    if (d.isYouTube) {
        if (d.ytPlayer && typeof d.ytPlayer.pauseVideo === 'function') d.ytPlayer.pauseVideo();
        d.isYouTube = false;
        d.playing   = false;
        setYTMode(deck, false);
    }
    initAudio();
    if (d.playing) { pauseDeck(deck); } else { playDeck(deck, url); }
}

function playDeck(deck, url) {
    const d = decks[deck];

    if (d.currentUrl !== url) {
        // New URL: tear down old audio element and source node
        if (d.source) { try { d.source.disconnect(); } catch {} d.source = null; }
        if (d.audio) d.audio.pause();
        d.audio          = new Audio();
        d.audio.src      = url;
        d.currentUrl     = url;
        d.webAudioActive = false;
        setTrackName(deck, extractName(url), null);
        addToHistory(deck, url);
        d.bpmHistory   = [];
        d.currentBPM   = null;
        d.lastBeatTime = 0;
        document.getElementById(`bpm-${deck.toLowerCase()}`).textContent = '--';
        document.getElementById(`bpm-vinyl-${deck.toLowerCase()}`).textContent = '--';
        // Build chain for new URL
        createDeckChain(deck);
    } else if (!d.gainNode) {
        // Same URL but chain was torn down (e.g. audio context reset)
        createDeckChain(deck);
    }
    // On same URL with intact chain: skip createDeckChain to preserve currentTime

    if (!d.source && d.gainNode) {
        try {
            d.source = ctx.createMediaElementSource(d.audio);
            d.source.connect(d.gainNode);
            d.webAudioActive = true;
        } catch (e) {
            d.webAudioActive = false;
            d.source = null;
        }
    }

    const volEl = document.getElementById(`vol-${deck.toLowerCase()}`);
    updateDeckVolume(deck, parseInt(volEl.value));

    d.audio.play().catch(e => showToast('Errore: ' + e.message));
    d.playing = true;

    updateDeckUI(deck, true);
    postNUI('playDeck', { deck, url, volume: d.webAudioActive ? d.gainNode.gain.value : d.audio.volume });
    startRaf();

    // Fix 8: ri-broadcast se era attivo
    if (broadcastActive) sendBroadcast();
}

function pauseDeck(deck) {
    const d = decks[deck];
    if (d.isYouTube) { pauseYouTube(deck); return; }
    if (d.audio) d.audio.pause();
    d.playing = false;
    updateDeckUI(deck, false);
}

function stopDeck(deck) {
    const d = decks[deck];
    if (d.isYouTube) { stopYouTube(deck); return; }
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
    if (playing) {
        playBtn.classList.add('active');
        playBtn.textContent = '⏸';
        vinyl.classList.add('spinning');
    } else {
        playBtn.classList.remove('active');
        playBtn.textContent = '▶/II';
        vinyl.classList.remove('spinning');
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
                if (d.isYouTube && d.ytPlayer && typeof d.ytPlayer.getCurrentTime === 'function') {
                    d.cueTime = d.ytPlayer.getCurrentTime() || 0;
                } else {
                    d.cueTime = d.audio ? d.audio.currentTime : 0;
                }
                btn.classList.add('active');
                setTimeout(() => btn.classList.remove('active'), 300);
            } else if (d.currentUrl) {
                // Avvia preview dal cue point
                d.cuePreview = true;
                if (d.isYouTube && d.ytPlayer && typeof d.ytPlayer.seekTo === 'function') {
                    d.ytPlayer.seekTo(d.cueTime, true);
                    d.ytPlayer.playVideo();
                    d.playing = true;
                    updateDeckUI(deck, true);
                    startRaf();
                } else if (d.audio) {
                    d.audio.currentTime = d.cueTime;
                    d.audio.play().catch(() => {});
                    d.playing = true;
                    updateDeckUI(deck, true);
                    startRaf();
                }
                btn.classList.add('active');
            }
        });

        const stopPreview = () => {
            const d = decks[deck];
            if (d.cuePreview) {
                d.cuePreview = false;
                if (d.isYouTube && d.ytPlayer && typeof d.ytPlayer.pauseVideo === 'function') {
                    d.ytPlayer.pauseVideo();
                    d.ytPlayer.seekTo(d.cueTime, true);
                    d.playing = false;
                    updateDeckUI(deck, false);
                } else {
                    pauseDeck(deck);
                    if (d.audio) d.audio.currentTime = d.cueTime;
                }
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
    ['A', 'B'].forEach(deck => {
        if (decks[deck].isYouTube)          applyYTVolume(deck);
        else if (!decks[deck].webAudioActive) applyDirectVolume(deck);
    });
    postNUI('setVolume', { type: 'master', value: val });
}

function updateDeckVolume(deck, val) {
    savePref(`vol${deck}`, val);
    const d = decks[deck];
    if (d.isYouTube) {
        applyYTVolume(deck);
    } else if (d.webAudioActive && d.gainNode && ctx) {
        const base   = val / 100;
        const cf     = crossfadeValue;
        const cfGain = deck === 'A'
            ? Math.cos(cf * Math.PI / 2)
            : Math.sin(cf * Math.PI / 2);
        d.gainNode.gain.setTargetAtTime(base * cfGain, ctx.currentTime, 0.015);
    } else {
        applyDirectVolume(deck);
    }
}

// Fallback: controlla volume direttamente sull'elemento Audio
// quando Web Audio API non è disponibile (sorgente non CORS)
function applyDirectVolume(deck) {
    const d = decks[deck];
    if (!d.audio) return;
    const volEl    = document.getElementById(`vol-${deck.toLowerCase()}`);
    const masterEl = document.getElementById('master-vol');
    const base     = volEl    ? parseInt(volEl.value)    / 100 : 0.8;
    const master   = masterEl ? parseInt(masterEl.value) / 100 : 0.8;
    const cf       = crossfadeValue;
    const cfGain   = deck === 'A'
        ? Math.cos(cf * Math.PI / 2)
        : Math.sin(cf * Math.PI / 2);
    d.audio.volume = Math.max(0, Math.min(1, base * cfGain * master));
}

function updateCrossfader(val) {
    crossfadeValue = val / 100;
    savePref('crossfader', val);
    const pos = val < 40 ? 'DECK A' : val > 60 ? 'DECK B' : 'CENTER';
    document.getElementById('cf-pos').textContent = pos;
    updateDeckVolume('A', parseInt(document.getElementById('vol-a').value));
    updateDeckVolume('B', parseInt(document.getElementById('vol-b').value));
    ['A', 'B'].forEach(deck => {
        if (decks[deck].isYouTube)           applyYTVolume(deck);
        else if (!decks[deck].webAudioActive) applyDirectVolume(deck);
    });
}

function updatePitch(deck, val) {
    const f  = parseFloat(val);
    const dl = deck.toLowerCase();
    const label = `${f > 0 ? '+' : ''}${f.toFixed(1)}%`;
    document.getElementById(`pitch-val-${dl}`).textContent  = label;
    document.getElementById(`vinyl-pitch-${dl}`).textContent = label;
    const d = decks[deck];
    if (d.isYouTube) return;
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
const activeLoopBars = { A: 0, B: 0 };

function setLoop(bars, deck, btn) {
    const d  = decks[deck];
    const dl = deck.toLowerCase();

    // Toggle: same button deactivates
    if (activeLoopBars[deck] === bars && d.loopActive) {
        activeLoopBars[deck] = 0;
        d.loopActive = false;
        document.querySelectorAll(`.deck-${dl} .loop-btn`).forEach(b => b.classList.remove('active'));
        return;
    }

    if (!d.playing) { showToast('Avvia il deck prima'); return; }

    activeLoopBars[deck] = bars;
    document.querySelectorAll(`.deck-${dl} .loop-btn`).forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    const bpm          = d.currentBPM || 120;
    const loopDuration = bars * 4 * (60 / bpm);
    let   currentTime  = 0;
    if (d.isYouTube && d.ytPlayer && typeof d.ytPlayer.getCurrentTime === 'function') {
        currentTime = d.ytPlayer.getCurrentTime() || 0;
    } else if (d.audio) {
        currentTime = d.audio.currentTime;
    } else { return; }

    d.loopActive = true;
    d.loopStart  = currentTime;
    d.loopEnd    = currentTime + loopDuration;
}

// Chiamato ogni frame RAF
function checkLoop(deck) {
    const d = decks[deck];
    if (!d.loopActive || !d.playing) return;
    if (d.isYouTube && d.ytPlayer && typeof d.ytPlayer.getCurrentTime === 'function') {
        if (d.ytPlayer.getCurrentTime() >= d.loopEnd) d.ytPlayer.seekTo(d.loopStart, true);
    } else if (d.audio) {
        if (d.audio.currentTime >= d.loopEnd) d.audio.currentTime = d.loopStart;
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
        drawWaveform('A');
        drawWaveform('B');
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
    if (deck.playing && deck.webAudioActive && deck.analyser && deck.analyserData) {
        // VU reale tramite AnalyserNode (solo se Web Audio attivo)
        deck.analyser.getByteFrequencyData(deck.analyserData);
        const sum = deck.analyserData.reduce((a, b) => a + b, 0);
        level = sum / (deck.analyserData.length * 255);
    } else if (deck.playing) {
        // Fallback simulato: oscillazione naturalistica con smoothing
        const target = 0.25 + Math.random() * 0.5;
        deck._vuLevel = deck._vuLevel !== undefined
            ? deck._vuLevel * 0.7 + target * 0.3
            : target;
        level = deck._vuLevel;
    }
    const n = bars.length;
    const filled = Math.round(level * n);
    bars.forEach((bar, i) => {
        bar.classList.remove('active-green', 'active-yellow', 'active-red');
        if (i < filled) {
            if      (i < n * 0.55) bar.classList.add('active-green');
            else if (i < n * 0.80) bar.classList.add('active-yellow');
            else                   bar.classList.add('active-red');
        }
    });
    // Aggiorna anche i VU master (media dei due deck)
    ['mvu-l','mvu-r'].forEach(id => {
        const mvBars = document.getElementById(id)?.querySelectorAll('.vu-bar');
        if (!mvBars) return;
        const mn = mvBars.length;
        const mf = Math.round(level * mn);
        mvBars.forEach((b, i) => {
            b.classList.remove('active-green','active-yellow','active-red');
            if (i < mf) {
                if      (i < mn * 0.55) b.classList.add('active-green');
                else if (i < mn * 0.80) b.classList.add('active-yellow');
                else                    b.classList.add('active-red');
            }
        });
    });
}

// ============================================================
// Fix 3 – BPM Detection (energy-based, banda bassa 60-200Hz)
// ============================================================
function detectBPM(deck) {
    const d = decks[deck];
    if (!d.playing || !d.webAudioActive || !d.bpmAnalyser || !d.bpmData || !ctx) return;

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
                        const dl = deck.toLowerCase();
                        document.getElementById(`bpm-${dl}`).textContent       = bpm;
                        document.getElementById(`bpm-vinyl-${dl}`).textContent = bpm;
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
    const d  = decks[deck];
    const dl = deck.toLowerCase();
    if (!d.playing) return;

    let t = 0, dur = 0;
    if (d.isYouTube && d.ytPlayer && typeof d.ytPlayer.getCurrentTime === 'function') {
        t   = d.ytPlayer.getCurrentTime() || 0;
        dur = typeof d.ytPlayer.getDuration === 'function' ? (d.ytPlayer.getDuration() || 0) : 0;
    } else if (d.audio) {
        t   = d.audio.currentTime;
        dur = d.audio.duration || 0;
    } else { return; }

    const fmt = sec => `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2,'0')}`;
    document.getElementById(`time-${dl}`).textContent = fmt(t);
    if (dur && isFinite(dur)) {
        document.getElementById(`dur-${dl}`).textContent = fmt(dur);
    }
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
    const el = document.getElementById('dj-console');
    if (el.classList.contains('hidden')) return;  // evita il loop NUI↔Lua
    el.classList.add('hidden');
    // Forza blur sugli iframe YouTube per restituire il mouse al gioco
    document.querySelectorAll('iframe').forEach(f => { try { f.blur(); } catch {} });
    document.body.focus();
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
    fetch(`https://djconsolle/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).catch(() => {});
}

function setTrackName(deck, name, videoId) {
    const dl = deck.toLowerCase();
    document.getElementById(`track-name-${dl}`).textContent = name;
    const thumb = document.getElementById(`thumb-${dl}`);
    if (videoId && thumb) {
        thumb.innerHTML = `<img src="https://img.youtube.com/vi/${videoId}/default.jpg" alt="">`;
    } else if (thumb) {
        thumb.textContent = '♪';
    }
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

// ============================================================
// ============================================================
// Hot Cues
// ============================================================
function triggerHotCue(deck, num) {
    const d = decks[deck];
    const idx = num - 1;
    const btn = document.getElementById(`hc-${deck.toLowerCase()}-${num}`);
    if (d.hotCues[idx] !== null) {
        if (d.isYouTube && d.ytPlayer) d.ytPlayer.seekTo(d.hotCues[idx], true);
        else if (d.audio) d.audio.currentTime = d.hotCues[idx];
        if (btn) { btn.classList.add('active'); setTimeout(() => btn.classList.remove('active'), 200); }
    } else {
        let pos = 0;
        if (d.isYouTube && d.ytPlayer) pos = d.ytPlayer.getCurrentTime() || 0;
        else if (d.audio) pos = d.audio.currentTime;
        d.hotCues[idx] = pos;
        if (btn) btn.classList.add('set');
    }
}
function clearHotCue(deck, num) {
    decks[deck].hotCues[num - 1] = null;
    const btn = document.getElementById(`hc-${deck.toLowerCase()}-${num}`);
    if (btn) btn.classList.remove('set');
}

// ============================================================
// SYNC – eguaglia BPM del deck al deck opposto
// ============================================================
function syncDeck(deck) {
    const other = deck === 'A' ? 'B' : 'A';
    const d = decks[deck], o = decks[other];
    if (!o.currentBPM) { showToast('TAP BPM sull\'altro deck prima'); return; }
    if (!d.currentBPM) { showToast('TAP BPM su questo deck prima'); return; }
    if (d.isYouTube) { showToast('SYNC non disponibile su YouTube'); return; }
    const ratio = o.currentBPM / d.currentBPM;
    if (d.audio) d.audio.playbackRate = Math.max(0.5, Math.min(2, ratio));
    const f = (ratio - 1) * 100;
    document.getElementById(`pitch-val-${deck.toLowerCase()}`).textContent =
        `${f >= 0 ? '+' : ''}${f.toFixed(1)}%`;
}

// ============================================================
// Pitch Bend (mousedown/mouseup)
// ============================================================
const _bendTimers = {};
function startBend(deck, dir) {
    stopBend(deck);
    _bendTimers[deck] = setInterval(() => {
        const d = decks[deck];
        if (!d.isYouTube && d.audio)
            d.audio.playbackRate = Math.max(0.5, Math.min(2, d.audio.playbackRate + dir * 0.003));
    }, 40);
}
function stopBend(deck) {
    clearInterval(_bendTimers[deck]);
    delete _bendTimers[deck];
    const slider = document.getElementById(`pitch-${deck.toLowerCase()}`);
    const d = decks[deck];
    if (slider && d.audio && !d.isYouTube)
        d.audio.playbackRate = 1 + parseFloat(slider.value) / 100;
}

// ============================================================
// Waveform canvas
// ============================================================
const _waveCache = {};
function _waveData(url, bars) {
    if (_waveCache[url]) return _waveCache[url];
    let h = 0;
    for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
    const data = Array.from({length: bars}, () => {
        h = (h * 1664525 + 1013904223) | 0;
        return 0.15 + ((h >>> 0) / 0xFFFFFFFF) * 0.85;
    });
    _waveCache[url] = data;
    return data;
}
function drawWaveform(deck) {
    const d = decks[deck];
    const canvas = document.getElementById(`waveform-${deck.toLowerCase()}`);
    if (!canvas) return;
    const c = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    c.clearRect(0, 0, w, h);
    if (!d.currentUrl) return;
    const bars = 80;
    const data = _waveData(d.currentUrl, bars);
    let pos = 0;
    if (d.isYouTube && d.ytPlayer && typeof d.ytPlayer.getDuration === 'function') {
        const dur = d.ytPlayer.getDuration() || 1;
        pos = (d.ytPlayer.getCurrentTime() || 0) / dur;
    } else if (d.audio && d.audio.duration) {
        pos = d.audio.currentTime / d.audio.duration;
    }
    const isA = deck === 'A';
    const played   = isA ? '#0066aa' : '#660099';
    const unplayed = isA ? '#001a33' : '#1a0033';
    const bright   = isA ? '#00aaff' : '#aa00ff';
    const bw = w / bars;
    data.forEach((amp, i) => {
        const bh = amp * h * 0.88;
        const by = (h - bh) / 2;
        c.fillStyle = (i / bars < pos) ? played : unplayed;
        c.fillRect(i * bw + 1, by, bw - 2, bh);
    });
    // playhead
    const px = pos * w;
    c.strokeStyle = bright;
    c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(px, 0); c.lineTo(px, h); c.stroke();
}

// ============================================================
// Crossfader curve canvas
// ============================================================
function drawCFCurve() {
    const canvas = document.getElementById('cf-curve-canvas');
    if (!canvas) return;
    const c = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    c.clearRect(0, 0, w, h);
    c.strokeStyle = '#aa00ff';
    c.lineWidth = 2;
    c.beginPath();
    for (let x = 0; x <= w; x++) {
        const t = x / w;
        const y = h - (1 / (1 + Math.exp(-10 * (t - 0.5)))) * h;
        x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.stroke();
    const mx = crossfadeValue * w;
    c.fillStyle = '#ff00aa';
    c.beginPath(); c.arc(mx, h / 2, 5, 0, Math.PI * 2); c.fill();
}

// ============================================================
// Global EQ (master output)
// ============================================================
let _globalEQ = null;
function _initGlobalEQ() {
    if (!ctx || _globalEQ) return;
    const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 200;
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.5;
    const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 8000;
    masterGain.disconnect();
    masterGain.connect(lo); lo.connect(mid); mid.connect(hi); hi.connect(ctx.destination);
    _globalEQ = { lo, mid, hi };
}
function applyGlobalEQ() {
    if (!ctx) return;
    _initGlobalEQ();
    if (!_globalEQ) return;
    _globalEQ.lo.gain.value  = parseFloat(document.getElementById('geq-lo').value);
    _globalEQ.mid.gain.value = parseFloat(document.getElementById('geq-mid').value);
    _globalEQ.hi.gain.value  = parseFloat(document.getElementById('geq-hi').value);
}

// ============================================================
// Clock
// ============================================================
function updateClock() {
    const n = new Date();
    const el = document.getElementById('clock-display');
    if (el) el.textContent = `${n.getHours().toString().padStart(2,'0')}:${n.getMinutes().toString().padStart(2,'0')}`;
}

// ============================================================
// Sampler – suoni sintetici via Web Audio API
// ============================================================
function playSample(name) {
    if (!ctx) initAudio();
    if (!ctx) return;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    const t = ctx.currentTime;
    const defs = {
        scratch: () => {
            // Noise burst with bandpass sweep + rapid amplitude wobble
            const buf = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
            const bd  = buf.getChannelData(0);
            for (let i = 0; i < bd.length; i++) bd[i] = (Math.random() * 2 - 1) * Math.sin(i * 0.3);
            const s = ctx.createBufferSource(); s.buffer = buf;
            const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 3;
            f.frequency.setValueAtTime(4000, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.15);
            f.frequency.exponentialRampToValueAtTime(2000, t + 0.25); f.frequency.exponentialRampToValueAtTime(200, t + 0.4);
            s.connect(f); f.connect(g);
            g.gain.setValueAtTime(0.9, t); g.gain.setValueAtTime(0.4, t + 0.08); g.gain.setValueAtTime(0.9, t + 0.16);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.4); s.start(t);
        },
        airhorn: () => {
            // Loud air horn: sawtooth + harmonics
            [220, 277, 330, 440].forEach((freq, i) => {
                const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq;
                const og = ctx.createGain(); og.gain.value = 0.35 / (i + 1);
                o.connect(og); og.connect(g); o.start(t); o.stop(t + 1.8);
            });
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.85, t + 0.04);
            g.gain.setValueAtTime(0.85, t + 1.4); g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
        },
        drop: () => {
            // Sub bass frequency sweep down — the "bass drop"
            const o = ctx.createOscillator(); o.frequency.setValueAtTime(120, t);
            o.frequency.exponentialRampToValueAtTime(28, t + 1.0);
            const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 200;
            o.connect(f); f.connect(g);
            g.gain.setValueAtTime(0.95, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
            o.start(t); o.stop(t + 1.2);
        },
        stab: () => {
            // Punchy synth stab
            const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 220;
            const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(3000, t);
            f.frequency.exponentialRampToValueAtTime(300, t + 0.12); f.Q.value = 6;
            o.connect(f); f.connect(g);
            g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
            o.start(t); o.stop(t + 0.12);
        },
        woosh: () => {
            // White noise bandpass sweep (high→low = incoming, low→high = outgoing)
            const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
            const bd  = buf.getChannelData(0); for (let i = 0; i < bd.length; i++) bd[i] = Math.random() * 2 - 1;
            const s = ctx.createBufferSource(); s.buffer = buf;
            const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
            f.frequency.setValueAtTime(8000, t); f.frequency.exponentialRampToValueAtTime(100, t + 0.9);
            s.connect(f); f.connect(g);
            g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9); s.start(t);
        },
        laser: () => {
            // Descending sine sweep — classic laser
            const o = ctx.createOscillator();
            o.frequency.setValueAtTime(3000, t); o.frequency.exponentialRampToValueAtTime(80, t + 0.6);
            o.connect(g); g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
            o.start(t); o.stop(t + 0.6);
        },
        alarm: () => {
            // Alternating two-tone alarm
            [0, 0.18, 0.36, 0.54, 0.72, 0.9].forEach((off, i) => {
                const o = ctx.createOscillator(); o.frequency.value = i % 2 === 0 ? 960 : 720;
                const ag = ctx.createGain(); ag.gain.setValueAtTime(0.55, t+off); ag.gain.exponentialRampToValueAtTime(0.001, t+off+0.16);
                o.connect(ag); ag.connect(ctx.destination); o.start(t+off); o.stop(t+off+0.16);
            });
        },
        rewind: () => {
            // Noise + rising pitch = "rewind" effect
            const o = ctx.createOscillator(); o.type = 'sawtooth';
            o.frequency.setValueAtTime(60, t); o.frequency.exponentialRampToValueAtTime(1200, t + 0.7);
            const buf = ctx.createBuffer(1, ctx.sampleRate * 0.7, ctx.sampleRate);
            const bd  = buf.getChannelData(0); for (let i = 0; i < bd.length; i++) bd[i] = (Math.random() * 2 - 1) * 0.25;
            const ns = ctx.createBufferSource(); ns.buffer = buf;
            o.connect(g); ns.connect(g);
            g.gain.setValueAtTime(0.75, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
            o.start(t); o.stop(t + 0.7); ns.start(t);
        },
    };
    if (defs[name]) defs[name]();
    const btn = document.querySelector(`.smp-btn[onclick*="${name}"]`);
    if (btn) { btn.classList.add('active'); setTimeout(() => btn.classList.remove('active'), 600); }
}

// TAP BPM – calcola BPM dagli intervalli tra tap manuali
// Resetsa automaticamente se il tap arriva dopo >3s dall'ultimo
// ============================================================
const tapState = { A: { times: [] }, B: { times: [] } };

function tapBPM(deck) {
    const now  = performance.now();
    const state = tapState[deck];

    // Reset se è passato troppo tempo dall'ultimo tap
    if (state.times.length > 0 && now - state.times[state.times.length - 1] > 3000) {
        state.times = [];
    }

    state.times.push(now);
    if (state.times.length > 8) state.times.shift();   // mantieni ultimi 8

    if (state.times.length >= 2) {
        let totalInterval = 0;
        for (let i = 1; i < state.times.length; i++) {
            totalInterval += state.times[i] - state.times[i - 1];
        }
        const avgInterval = totalInterval / (state.times.length - 1);
        const bpm = Math.round(60000 / avgInterval);
        if (bpm >= 40 && bpm <= 220) {
            decks[deck].currentBPM = bpm;
            const dl = deck.toLowerCase();
            document.getElementById(`bpm-${dl}`).textContent       = bpm;
            document.getElementById(`bpm-vinyl-${dl}`).textContent = bpm;
        }
    }

    // Flash visivo sul bottone
    const btn = document.querySelector(`.deck-${deck.toLowerCase()} .tap-btn`);
    if (btn) {
        btn.classList.add('tapping');
        setTimeout(() => btn.classList.remove('tapping'), 100);
    }
}

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
updateClock();
setInterval(updateClock, 10000);
