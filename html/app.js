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

function makeDeck() {
    return {
        audio: null, source: null, gainNode: null,
        analyser: null, analyserData: null,
        bpmAnalyser: null, bpmData: null,
        playing: false, cueTime: 0, cueSet: false, currentUrl: null, currentBPM: null,
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

function setYTMode(deck, active) {
    const dl      = deck.toLowerCase();
    const nameBadge = document.getElementById(`track-name-${dl}`);
    if (nameBadge) nameBadge.dataset.mode = active ? 'yt' : '';
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
    d.cueSet     = false;
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
// Deck chain: gainNode -> analyser -> masterGain
//                       -> bpmAnalyser
// ============================================================
function teardownDeckChain(deck) {
    const d = decks[deck];
    // Disconnette l'analyser da masterGain — senza questo ogni rebuild
    // aggiunge un nodo in più al grafo audio senza mai rimuovere il precedente
    if (d.analyser) { try { d.analyser.disconnect(); } catch {} }
    if (d.gainNode)  { try { d.gainNode.disconnect();  } catch {} }
    d.gainNode = null;
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

    // VU analyser
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;

    // BPM analyser (separato, no output audio)
    const bpmAnalyser = ctx.createAnalyser();
    bpmAnalyser.fftSize = 1024;
    bpmAnalyser.smoothingTimeConstant = 0.3;

    // Connessioni
    gainNode.connect(analyser);
    gainNode.connect(bpmAnalyser);
    analyser.connect(masterGain);

    d.gainNode = gainNode;
    d.analyser = analyser;
    d.analyserData = new Uint8Array(analyser.frequencyBinCount);
    d.bpmAnalyser = bpmAnalyser;
    d.bpmData = new Uint8Array(bpmAnalyser.frequencyBinCount);

    // Applica crossfade corretto
    const volEl = document.getElementById(`vol-${deck.toLowerCase()}`);
    updateDeckVolume(deck, parseInt(volEl.value));
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
                d.cueTime = 0;
                d.cueSet = false;
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
        d.cueTime        = 0;
        d.cueSet         = false;
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
    d.cueSet     = false;
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
                d.cueSet = true;
                btn.classList.add('active');
                setTimeout(() => btn.classList.remove('active'), 300);
            } else if (d.currentUrl) {
                if (!d.cueSet) {
                    if (d.isYouTube && d.ytPlayer && typeof d.ytPlayer.getCurrentTime === 'function') {
                        d.cueTime = d.ytPlayer.getCurrentTime() || 0;
                    } else if (d.audio) {
                        d.cueTime = d.audio.currentTime || 0;
                    }
                    d.cueSet = true;
                }
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
            // Noise + rising tone = "rewind" effect
            const o = ctx.createOscillator(); o.type = 'sawtooth';
            o.frequency.setValueAtTime(60, t); o.frequency.exponentialRampToValueAtTime(1200, t + 0.7);
            const buf = ctx.createBuffer(1, ctx.sampleRate * 0.7, ctx.sampleRate);
            const bd  = buf.getChannelData(0); for (let i = 0; i < bd.length; i++) bd[i] = (Math.random() * 2 - 1) * 0.25;
            const ns = ctx.createBufferSource(); ns.buffer = buf;
            o.connect(g); ns.connect(g);
            g.gain.setValueAtTime(0.75, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
            o.start(t); o.stop(t + 0.7); ns.start(t);
        },
        kick: () => {
            const o = ctx.createOscillator();
            o.frequency.setValueAtTime(140, t);
            o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
            o.connect(g);
            g.gain.setValueAtTime(1, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
            o.start(t); o.stop(t + 0.24);
        },
        snare: () => {
            const buf = ctx.createBuffer(1, ctx.sampleRate * 0.18, ctx.sampleRate);
            const bd = buf.getChannelData(0);
            for (let i = 0; i < bd.length; i++) bd[i] = Math.random() * 2 - 1;
            const s = ctx.createBufferSource(); s.buffer = buf;
            const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 900;
            const o = ctx.createOscillator(); o.frequency.value = 180;
            s.connect(f); f.connect(g); o.connect(g);
            g.gain.setValueAtTime(0.8, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
            s.start(t); o.start(t); o.stop(t + 0.08);
        },
        hat: () => {
            const buf = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
            const bd = buf.getChannelData(0);
            for (let i = 0; i < bd.length; i++) bd[i] = Math.random() * 2 - 1;
            const s = ctx.createBufferSource(); s.buffer = buf;
            const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 6000;
            s.connect(f); f.connect(g);
            g.gain.setValueAtTime(0.45, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
            s.start(t);
        },
        clap: () => {
            [0, 0.018, 0.036].forEach(off => {
                const buf = ctx.createBuffer(1, ctx.sampleRate * 0.09, ctx.sampleRate);
                const bd = buf.getChannelData(0);
                for (let i = 0; i < bd.length; i++) bd[i] = Math.random() * 2 - 1;
                const s = ctx.createBufferSource(); s.buffer = buf;
                const ag = ctx.createGain();
                ag.gain.setValueAtTime(0.35, t + off);
                ag.gain.exponentialRampToValueAtTime(0.001, t + off + 0.09);
                s.connect(ag); ag.connect(ctx.destination); s.start(t + off);
            });
        },
        riser: () => {
            const o = ctx.createOscillator(); o.type = 'sawtooth';
            o.frequency.setValueAtTime(160, t);
            o.frequency.exponentialRampToValueAtTime(1800, t + 1.2);
            o.connect(g);
            g.gain.setValueAtTime(0.001, t);
            g.gain.linearRampToValueAtTime(0.65, t + 1.1);
            g.gain.exponentialRampToValueAtTime(0.001, t + 1.25);
            o.start(t); o.stop(t + 1.25);
        },
        impact: () => {
            const o = ctx.createOscillator();
            o.frequency.setValueAtTime(90, t);
            o.frequency.exponentialRampToValueAtTime(26, t + 0.55);
            const buf = ctx.createBuffer(1, ctx.sampleRate * 0.35, ctx.sampleRate);
            const bd = buf.getChannelData(0);
            for (let i = 0; i < bd.length; i++) bd[i] = (Math.random() * 2 - 1) * (1 - i / bd.length);
            const s = ctx.createBufferSource(); s.buffer = buf;
            o.connect(g); s.connect(g);
            g.gain.setValueAtTime(0.95, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
            o.start(t); o.stop(t + 0.6); s.start(t);
        },
        beep: () => {
            [0, 0.12, 0.24].forEach(off => {
                const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 1200;
                const ag = ctx.createGain();
                ag.gain.setValueAtTime(0.35, t + off);
                ag.gain.exponentialRampToValueAtTime(0.001, t + off + 0.06);
                o.connect(ag); ag.connect(ctx.destination); o.start(t + off); o.stop(t + off + 0.06);
            });
        },
        sub: () => {
            const o = ctx.createOscillator();
            o.frequency.value = 48;
            o.connect(g);
            g.gain.setValueAtTime(0.9, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
            o.start(t); o.stop(t + 0.45);
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
