/* Quart de temps — lecteur (vitesse sans changement de hauteur, boucle A/B, BPM) + métronome. */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('atelier.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('atelier.' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
  };

  /* ---------------------------------------------------------------- Toast */
  let toastTimer = 0;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }

  const fmt = (t) => {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  };
  const fmtBpm = (b) => {
    if (b == null) return '';
    const r = Math.round(b * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',');
  };

  /* Couleurs */
  const hexRgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgbHex = (c) => '#' + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
  const mixHex = (a, b, k) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, i) => v + (y[i] - v) * k)); };
  const rgba = (h, a) => { const c = hexRgb(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; };
  const lum = (h) => { const c = hexRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };

  const C = {
    gold: '#F5BD41',
    slowLight: '#6AB4FF', slowDeep: '#2C50DE',
    fastDeep: '#2DD68E', fastLight: '#B2F7D8',
    fg: '#EEF2F8', ink: '#141833',
    idle: '#4D5590', idleLoop: '#8C7FC4',
    loopA: '#B9A7FF', loopB: '#EBA6F5',
    light: '#56C1FF', volLow: '#34465C'
  };

  /* --------------------------------------------------------- Contexte audio */
  let ctx = null, metroGain = null, clickBufs = null;
  function getCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = new AC(); }
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* iOS ancien */ }
      metroGain = ctx.createGain();
      metroGain.gain.value = volToGain(metro.vol);
      // Garde-fou : linéaire jusqu'à 0,85, puis arrondi doux vers 1 (jamais d'écrêtage brutal si deux sons se chevauchent)
      const guard = ctx.createWaveShaper();
      const curve = new Float32Array(2049);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / 1024) - 1, a = Math.abs(x), knee = 0.85;
        curve[i] = Math.sign(x) * (a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
      }
      guard.curve = curve;
      metroGain.connect(guard);
      guard.connect(ctx.destination);
      clickBufs = makeClicks(ctx);
      loadSamples(ctx);
    }
    return ctx;
  }

  /* Sons enregistrés (dossier Sound, fichiers intacts) : chargés une seule fois.
     Si un fichier manque, le clic d'origine prend le relais. */
  const SAMPLE_FILES = { clave: 'Sound/Clave.wav', cowbell: 'Sound/Cowbell.wav', wood: 'Sound/Wood.wav', conga: 'Sound/Conga.mp3' };
  const samples = {};
  function b64ToBuffer(b64) {
    const bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  /* Les sons enregistrés au même volume perçu (attaque des 120 premières ms), sans dépasser 0,95 en crête.
     La cloche et la conga étaient enregistrées 8 à 9 dB plus bas que la clave. */
  function normalize(ab) {
    const d0 = ab.getChannelData(0), n = Math.min(d0.length, Math.floor(ab.sampleRate * 0.12));
    let peak = 0, e = 0;
    for (let ch = 0; ch < ab.numberOfChannels; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
    for (let i = 0; i < n; i++) e += d0[i] * d0[i];
    const rms = Math.sqrt(e / (n || 1));
    if (peak > 0 && rms > 0) {
      const k = Math.min(0.95 / peak, 0.18 / rms);
      for (let ch = 0; ch < ab.numberOfChannels; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= k; }
    }
    return ab;
  }
  // Conga : attaque renforcée et résonance raccourcie (plus de claquant, moins de grave qui traîne)
  function punch(ab) {
    const sr = ab.sampleRate, nA = Math.floor(sr * 0.012), t0 = Math.floor(sr * 0.09);
    for (let ch = 0; ch < ab.numberOfChannels; ch++) {
      const d = ab.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        let g = 1;
        if (i < nA) g = 2.2 - 1.2 * (i / nA);
        else if (i > t0) g = Math.exp(-(i - t0) / (sr * 0.07));
        d[i] *= g;
      }
    }
    return ab;
  }
  function loadSamples(c) {
    Object.keys(SAMPLE_FILES).forEach((k) => {
      // D'abord la copie intégrée (sounds.js) : marche aussi en ouverture locale (file://) et hors ligne
      const embedded = window.SOUND_DATA && window.SOUND_DATA[k];
      const source = embedded
        ? Promise.resolve().then(() => b64ToBuffer(embedded))
        : fetch(SAMPLE_FILES[k]).then((r) => { if (!r.ok) throw new Error(k); return r.arrayBuffer(); });
      source
        .then((buf) => new Promise((res, rej) => { const p = c.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); }))
        .then((ab) => { samples[k] = normalize(k === 'conga' ? punch(ab) : ab); })
        .catch(() => { /* le clic d'origine sera utilisé */ });
    });
  }
  /* Joue une note du métronome à l'instant t : le 1 plus fort et un peu plus aigu,
     les accents marqués, les subdivisions plus douces */
  function playMetroNote(t, isBeat, st, first) {
    const smp = samples[metro.sound];
    const src = ctx.createBufferSource();
    if (smp) {
      let rate = 1, lvl = 0.88;
      if (!isBeat) { lvl = 0.46; rate = 0.89; } // subdivision : un ton plus grave, un peu plus douce
      else if (st === 2) { rate = first ? 1.12 : 1.05; lvl = 1; }
      src.buffer = smp;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = lvl;
      src.connect(g);
      g.connect(metroGain);
    } else {
      src.buffer = isBeat ? (st === 2 ? (first ? clickBufs.one : clickBufs.acc) : clickBufs.beat) : clickBufs.sub;
      src.connect(metroGain);
    }
    src.start(t);
    return src;
  }
  function unlock() {
    const c = getCtx();
    if (c.state !== 'running') return c.resume().catch(() => {});
    return Promise.resolve();
  }

  /* ===================================================================== */
  /*                               LECTEUR                                  */
  /* ===================================================================== */
  /* Lecteur : moteur de ralentissement Signalsmith Stretch (qualité studio, attaques de batterie nettes),
     avec le lecteur natif du navigateur en secours : pendant le décodage du morceau, ou si l'appareil
     ne peut pas faire tourner le moteur. L'objet imite l'élément <audio> : le reste de l'appli ne change pas. */
  const audio = (() => {
    const nat = new Audio();
    nat.preload = 'auto';
    nat.preservesPitch = true;
    nat.mozPreservesPitch = true;
    nat.webkitPreservesPitch = true;
    const et = new EventTarget();
    const S = { mode: 'nat', node: null, nodeP: null, failed: false, dur: NaN, rate: 1, rateTarget: 1, paused: true, ended: false,
      pos: 0, p0: 0, t0: 0, lat: 0, timer: 0, token: 0, keep: null };
    const fire = (type) => et.dispatchEvent(new Event(type));
    ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'seeked', 'error'].forEach((t) => {
      nat.addEventListener(t, () => { if (S.mode === 'nat') fire(t); });
    });
    // Petit son silencieux en boucle pendant la lecture : garde la session audio active
    // (écran verrouillé, commandes de lecture du téléphone, bouton silencieux de l'iPhone)
    function keepAlive(on) {
      try {
        if (!S.keep) {
          const n = 4000, b = new ArrayBuffer(44 + n), v = new DataView(b);
          const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
          w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
          v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
          for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
          S.keep = new Audio(URL.createObjectURL(new Blob([b], { type: 'audio/wav' })));
          S.keep.loop = true;
        }
        if (on) { const pr = S.keep.play(); if (pr && pr.catch) pr.catch(() => {}); } else S.keep.pause();
      } catch (e) { /* facultatif */ }
    }
    const ssPos = () => {
      if (S.paused) return S.pos;
      const p = S.p0 + Math.max(0, ctx.currentTime - S.t0 - S.lat) * S.rate;
      return Math.min(p, S.dur);
    };
    function ssStart(p) {
      S.p0 = p;
      S.t0 = ctx.currentTime;
      S.node.schedule({ active: true, input: p, rate: S.rate, semitones: 0 });
    }
    /* Changement de vitesse en cours de lecture : on n'arrête plus le moteur, on lui glisse vers la nouvelle vitesse
       (environ un dixième de seconde), sans saut ni craquement. */
    let rampId = 0;
    function ssRamp() {
      cancelAnimationFrame(rampId);
      const step = () => {
        if (S.mode !== 'ss' || S.paused) return;
        const d = S.rateTarget - S.rate, next = Math.abs(d) < 0.002 ? S.rateTarget : S.rate + d * 0.35;
        S.p0 = ssPos(); S.t0 = ctx.currentTime - S.lat;      // on repart de la position exacte avant de changer de vitesse
        S.rate = next;
        S.node.schedule({ rate: next });
        if (next !== S.rateTarget) rampId = requestAnimationFrame(step);
      };
      rampId = requestAnimationFrame(step);
    }
    function ssTick() {
      if (S.mode !== 'ss' || S.paused) return;
      if (ssPos() >= S.dur - 0.02) {
        S.pos = S.dur; S.paused = true; S.ended = true;
        S.node.schedule({ active: false });
        clearInterval(S.timer); keepAlive(false);
        fire('pause'); fire('ended');
        return;
      }
      fire('timeupdate');
    }
    function ssStop() {
      clearInterval(S.timer);
      if (S.node) S.node.schedule({ active: false });
      keepAlive(false);
    }
    function ensureNode() {
      if (S.nodeP) return S.nodeP;
      S.nodeP = (async () => {
        if (typeof window.SignalsmithStretch !== 'function' || !window.AudioWorkletNode) throw new Error('moteur indisponible');
        const c = getCtx();
        const node = await window.SignalsmithStretch(c, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
        node.connect(c.destination);
        if (document.body.classList.contains('lite')) { try { await node.configure({ preset: 'cheaper' }); } catch (e) { /* défaut */ } }
        try { S.lat = Math.max(0, Math.min(0.5, +(await node.latency()) || 0)); } catch (e) { S.lat = 0; }
        S.node = node;
        return node;
      })().catch((e) => { S.failed = true; console.warn('Ralentisseur Signalsmith indisponible, lecteur natif utilisé.', e); return null; });
      return S.nodeP;
    }
    function toNative() {
      if (S.mode === 'ss') { ssStop(); S.paused = true; }
      S.mode = 'nat';
      S.dur = NaN; S.pos = 0; S.ended = false;
    }
    const api = {
      addEventListener: (t, f, o) => et.addEventListener(t, f, o),
      removeEventListener: (t, f, o) => et.removeEventListener(t, f, o),
      get engine() { return S.mode === 'ss' ? 'signalsmith' : 'natif'; },
      get src() { return nat.src; },
      set src(v) { S.token++; toNative(); nat.src = v; },
      removeAttribute(a) { S.token++; toNative(); if (S.node) S.node.dropBuffers().catch(() => {}); nat.removeAttribute(a); },
      load() { nat.load(); },
      set preload(v) { nat.preload = v; },
      get paused() { return S.mode === 'ss' ? S.paused : nat.paused; },
      get ended() { return S.mode === 'ss' ? S.ended : nat.ended; },
      get seeking() { return S.mode === 'ss' ? false : nat.seeking; },
      get readyState() { return S.mode === 'ss' ? 4 : nat.readyState; },
      get duration() { return S.mode === 'ss' ? S.dur : nat.duration; },
      get currentTime() { return S.mode === 'ss' ? ssPos() : nat.currentTime; },
      set currentTime(v) {
        if (S.mode !== 'ss') { nat.currentTime = v; return; }
        S.pos = Math.max(0, Math.min(+v || 0, S.dur));
        S.ended = false;
        if (!S.paused) ssStart(S.pos);
        fire('seeked');
      },
      get playbackRate() { return S.rate; },
      set playbackRate(v) {
        nat.playbackRate = v;
        S.rateTarget = v;
        if (S.mode === 'ss' && !S.paused && v !== S.rate) ssRamp();
        else if (S.paused || S.mode !== 'ss') S.rate = v;
      },
      set defaultPlaybackRate(v) { nat.defaultPlaybackRate = v; },
      play() {
        if (S.mode !== 'ss') return nat.play();
        if (!S.paused) return Promise.resolve();
        if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
        if (S.ended || S.pos >= S.dur - 0.05) S.pos = 0;
        S.ended = false; S.paused = false;
        ssStart(S.pos);
        clearInterval(S.timer);
        S.timer = setInterval(ssTick, 200);
        keepAlive(true);
        fire('play');
        return Promise.resolve();
      },
      pause() {
        if (S.mode !== 'ss') { nat.pause(); return; }
        if (S.paused) return;
        S.pos = ssPos();
        if (S.rateTarget) S.rate = S.rateTarget;
        S.paused = true;
        cancelAnimationFrame(rampId);
        ssStop();
        fire('pause');
      },
      // Le morceau est décodé : on passe sur Signalsmith (au même endroit si la lecture a déjà commencé)
      async useDecoded(ab) {
        const token = S.token;
        const node = await ensureNode();
        if (!node || token !== S.token) return;
        try {
          await node.dropBuffers();
          const ch0 = ab.getChannelData(0);
          const chans = [ch0, ab.numberOfChannels > 1 ? ab.getChannelData(1) : new Float32Array(ch0)]; // mono : copie du canal (deux tampons distincts)
          await node.addBuffers(chans);
        } catch (e) { console.warn('Ralentisseur : chargement impossible, lecteur natif utilisé.', e); return; }
        if (token !== S.token) return;
        const wasPlaying = !nat.paused && !nat.ended;
        const at = nat.currentTime || 0;
        S.mode = 'ss';                       // à partir d'ici, les événements du lecteur natif sont ignorés
        S.dur = ab.duration; S.rate = nat.playbackRate || S.rate; S.pos = Math.min(at, S.dur); S.ended = false; S.paused = true;
        nat.pause();
        if (wasPlaying) api.play();
        fire('loadedmetadata');
      }
    };
    return api;
  })();

  const P = {
    hasTrack: false,
    decodedDur: 0,
    peaks: null,
    pps: 0,
    A: null,
    B: null,
    loop: false,
    speed: 100,
    zoneHex: C.gold,
    bpm: null,
    url: null,
    token: 0,
    name: ''
  };
  const dur = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : P.decodedDur);

  const player = $('player');
  let dirty = true;
  function setState(s) { player.dataset.state = s; dirty = true; }

  function cleanName(n) {
    return String(n || 'Morceau').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ').trim() || 'Morceau';
  }
  function isAudioFile(file) {
    return /\.(mp3|wav|wave|m4a|mp4|aac)$/i.test(file.name || '') || /^audio\//.test(file.type || '');
  }

  /* Fenêtre visible de l'onde (en secondes) et curseur fixe à 40 % */
  const VIEW = { span: 11, min: 3, cursor: 0.4, anim: null };
  const maxSpan = () => Math.max(VIEW.min, dur() || 11);
  function resetView() { VIEW.span = Math.min(11, maxSpan()); VIEW.anim = null; }

  async function loadFile(file) {
    if (!file) return;
    if (!isAudioFile(file)) { toast('Ce fichier n’est pas un son. Choisis un MP3, WAV ou M4A.'); return; }
    const token = ++P.token;
    if (metro.running) stopMetro();   // on libère toute la machine pour charger le morceau
    audio.pause();
    if (P.url) URL.revokeObjectURL(P.url);
    P.url = URL.createObjectURL(file);
    audio.src = P.url;
    audio.defaultPlaybackRate = audio.playbackRate = P.speed / 100;
    audio.load();
    P.hasTrack = true; P.A = P.B = null; P.loop = false; P.bpm = null; P.peaks = null; P.pps = 0; P.decodedDur = 0;
    P.name = cleanName(file.name);
    $('trackTitle').textContent = P.name;
    $('trackTitle').title = P.name;
    document.body.classList.add('has-track');
    resetView();
    setState('loading');
    setMediaSession();
    renderTransport(); renderLoop(); renderBpm();

    try {
      const buf = await file.arrayBuffer();
      const c = getCtx();
      const ab = await new Promise((res, rej) => {
        const p = c.decodeAudioData(buf, res, rej);
        if (p && p.then) p.then(res, rej);
      });
      if (token !== P.token) return;
      P.decodedDur = ab.duration;
      audio.useDecoded(ab);
      const chans = [];
      for (let i = 0; i < Math.min(2, ab.numberOfChannels); i++) {
        const a = new Float32Array(ab.length);
        if (ab.copyFromChannel) ab.copyFromChannel(a, i); else a.set(ab.getChannelData(i));
        chans.push(a);
      }
      // ~50 tranches par seconde : assez fin pour zoomer sur quelques secondes
      const nPeaks = clamp(Math.ceil(ab.duration * 50), 400, 90000);
      const res = await analyse(chans, ab.sampleRate, nPeaks);
      if (token !== P.token) return;
      P.peaks = res.peaks;
      P.pps = res.peaks.length / ab.duration;
      P.bpm = res.bpm;
      if (VIEW.span > maxSpan()) VIEW.span = maxSpan();
      setState('ready');
      if (P.bpm == null) toast('BPM non détecté : double-touche « BPM d’origine » pour le saisir.', 3800);
      // Chaque morceau ouvert : le ralentisseur s'ouvre, la vitesse est directement accessible
      hideSpeedHint();
      setTempoOpen(true);
    } catch (err) {
      if (token !== P.token) return;
      console.warn(err);
      P.peaks = null;
      setState('ready');
      toast('Forme d’onde indisponible pour ce fichier, mais la lecture fonctionne.', 3400);
    }
    renderTransport(); renderLoop(); renderBpm();
  }

  function removeTrack() {
    P.token++;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (P.url) { URL.revokeObjectURL(P.url); P.url = null; }
    Object.assign(P, { hasTrack: false, decodedDur: 0, peaks: null, pps: 0, A: null, B: null, loop: false, bpm: null, name: '' });
    document.body.classList.remove('has-track');
    $('trackTitle').textContent = '';
    resetView();
    setState('empty');
    renderTransport(); renderLoop(); renderBpm();
    try { if ('mediaSession' in navigator) navigator.mediaSession.metadata = null; } catch (e) { /* ignoré */ }
    updateWake();
    toast('Morceau retiré');
  }

  audio.addEventListener('error', () => {
    if (!P.hasTrack || !audio.src) return;
    toast('Impossible de lire ce fichier. Essaie un MP3.', 3400);
  });
  audio.addEventListener('loadedmetadata', () => {
    audio.playbackRate = P.speed / 100;
    if (VIEW.span > maxSpan()) VIEW.span = maxSpan();
    dirty = true;
  });
  const glass = document.querySelector('.wave-glass');
  audio.addEventListener('play', () => {
    renderPlay(); updateWake();
    if (!reduceMotion) { glass.classList.remove('sweep'); void glass.offsetWidth; glass.classList.add('sweep'); }
  });
  audio.addEventListener('pause', () => { renderPlay(); updateWake(); dirty = true; });
  audio.addEventListener('ended', () => { renderPlay(); updateWake(); dirty = true; });
  audio.addEventListener('timeupdate', checkLoop);
  audio.addEventListener('seeked', () => { dirty = true; });

  /* ---------- Analyse (forme d'onde + BPM) dans un worker ---------- */
  function analysisLib() {
    function fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let j = 0; j < h; j++) {
            const a = i + j, b = a + h;
            const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
            const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
          }
        }
      }
    }

    function peaksOf(chans, nPeaks) {
      const nc = chans.length, len = chans[0].length, per = len / nPeaks;
      const rms = new Float32Array(nPeaks), pk = new Float32Array(nPeaks), out = new Float32Array(nPeaks);
      let maxR = 1e-9, maxP = 1e-9;
      for (let p = 0; p < nPeaks; p++) {
        const s = Math.floor(p * per), e = Math.min(len, Math.max(s + 1, Math.floor((p + 1) * per)));
        const step = Math.max(1, Math.floor((e - s) / 3000));
        let m = 0, q = 0, cnt = 0;
        for (let i = s; i < e; i += step) {
          let v = 0;
          for (let c = 0; c < nc; c++) v += chans[c][i];
          v /= nc;
          const a = v < 0 ? -v : v;
          if (a > m) m = a;
          q += v * v; cnt++;
        }
        rms[p] = Math.sqrt(q / Math.max(1, cnt)); pk[p] = m;
        if (rms[p] > maxR) maxR = rms[p];
        if (m > maxP) maxP = m;
      }
      for (let p = 0; p < nPeaks; p++) {
        const v = 0.7 * (rms[p] / maxR) + 0.3 * (pk[p] / maxP);
        out[p] = Math.min(1, Math.pow(v, 0.85));
      }
      return out;
    }

    function tempo(chans, sr) {
      const nc = chans.length, len = chans[0].length;
      const f = Math.max(1, Math.round(sr / 11025)), dsr = sr / f;
      const win = Math.floor(150 * sr);
      let s0 = 0, s1 = len;
      if (len > win) { s0 = Math.floor((len - win) / 2); s1 = s0 + win; }
      const n = Math.floor((s1 - s0) / f);
      if (n < dsr * 5) return null;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let a = 0;
        const b = s0 + i * f;
        for (let k = 0; k < f; k++) for (let c = 0; c < nc; c++) a += chans[c][b + k];
        x[i] = a / (f * nc);
      }
      // Enveloppe d'attaques : flux spectral (log-magnitude)
      const N = 1024, hop = 128, fps = dsr / hop, half = N >> 1;
      const frames = Math.floor((n - N) / hop);
      if (frames < 200) return null;
      const hann = new Float32Array(N);
      for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
      const re = new Float32Array(N), im = new Float32Array(N);
      let prev = new Float32Array(half), cur = new Float32Array(half);
      const env = new Float32Array(frames);
      for (let fr = 0; fr < frames; fr++) {
        const o = fr * hop;
        for (let i = 0; i < N; i++) { re[i] = x[o + i] * hann[i]; im[i] = 0; }
        fft(re, im);
        let flux = 0;
        for (let k = 1; k < half; k++) {
          const m = Math.log(1 + 100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
          cur[k] = m;
          const d = m - prev[k];
          if (d > 0) flux += d;
        }
        env[fr] = fr === 0 ? 0 : flux;
        const t = prev; prev = cur; cur = t;
      }
      // Retrait de la moyenne locale + redressement
      const w = Math.max(1, Math.round(fps * 0.4));
      const cs = new Float64Array(frames + 1);
      for (let i = 0; i < frames; i++) cs[i + 1] = cs[i] + env[i];
      const o = new Float32Array(frames);
      let mx = 1e-9;
      for (let i = 0; i < frames; i++) {
        const a = Math.max(0, i - w), b = Math.min(frames, i + w + 1);
        const v = env[i] - (cs[b] - cs[a]) / (b - a);
        o[i] = v > 0 ? v : 0;
        if (o[i] > mx) mx = o[i];
      }
      for (let i = 0; i < frames; i++) o[i] /= mx;

      // Autocorrélation + harmoniques + préférence autour de 115 BPM
      const minB = 50, maxB = 220;
      const Lmax = Math.ceil(60 * fps / minB) + 2;
      const Lcap = Math.min(frames - 2, Lmax * 4 + 4);
      const ac = new Float32Array(Lcap + 2);
      for (let L = 1; L <= Lcap; L++) {
        let s = 0;
        for (let i = 0, e = frames - L; i < e; i++) s += o[i] * o[i + L];
        ac[L] = s / (frames - L);
      }
      const acAt = (L) => {
        if (L < 1 || L >= Lcap) return 0;
        const i = Math.floor(L), r = L - i;
        return ac[i] * (1 - r) + ac[i + 1] * r;
      };
      const prior = (b) => Math.exp(-0.5 * Math.pow(Math.log2(b / 115) / 0.9, 2));
      let best = 0, bestS = -Infinity;
      for (let b = minB; b <= maxB; b += 0.5) {
        const L = 60 * fps / b;
        const s = (acAt(L) + 0.5 * acAt(2 * L) + 0.25 * acAt(4 * L)) * prior(b);
        if (s > bestS) { bestS = s; best = b; }
      }
      if (!(best > 0) || !(bestS > 0)) return null;

      // Affinage : énergie de l'enveloppe à la fréquence exacte du tempo (et harmoniques)
      const comb = (b) => {
        let tot = 0;
        const hs = [1, 2, 4], ws = [1, 0.5, 0.25];
        for (let h = 0; h < 3; h++) {
          const w0 = 2 * Math.PI * (b * hs[h] / 60) / fps;
          const zr = Math.cos(w0), zi = Math.sin(w0);
          let pr = 1, pi = 0, c = 0, s = 0;
          for (let i = 0; i < frames; i++) {
            c += o[i] * pr; s += o[i] * pi;
            const npr = pr * zr - pi * zi; pi = pr * zi + pi * zr; pr = npr;
          }
          tot += ws[h] * Math.sqrt(c * c + s * s);
        }
        return tot;
      };
      let fb = best, fs = -Infinity;
      for (let b = best * 0.975; b <= best * 1.025; b += 0.05) {
        const s = comb(b);
        if (s > fs) { fs = s; fb = b; }
      }
      let r = Math.round(fb * 10) / 10;
      if (Math.abs(r - Math.round(r)) <= 0.25) r = Math.round(r);
      return r;
    }

    function analyse(chans, sr, nPeaks) {
      const peaks = peaksOf(chans, nPeaks);
      let bpm = null;
      try { bpm = tempo(chans, sr); } catch (e) { bpm = null; }
      return { peaks: peaks, bpm: bpm };
    }
    return { analyse: analyse };
  }

  let analysisWorker = null;
  function analyse(chans, sr, nPeaks) {
    return new Promise((resolve, reject) => {
      try {
        if (!analysisWorker) {
          const src = 'var L=(' + analysisLib.toString() + ')();' +
            'self.onmessage=function(e){try{var r=L.analyse(e.data.chans,e.data.sr,e.data.nPeaks);self.postMessage(r,[r.peaks.buffer]);}catch(err){self.postMessage({error:String(err)});}};';
          analysisWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        }
        analysisWorker.onmessage = (e) => (e.data.error ? reject(new Error(e.data.error)) : resolve(e.data));
        analysisWorker.onerror = (e) => { e.preventDefault && e.preventDefault(); analysisWorker = null; fallback(); };
        analysisWorker.postMessage({ chans: chans, sr: sr, nPeaks: nPeaks }, chans.map((c) => c.buffer));
      } catch (e) {
        fallback();
      }
      function fallback() {
        setTimeout(() => {
          try { resolve(analysisLib().analyse(chans, sr, nPeaks)); } catch (err) { reject(err); }
        }, 30);
      }
    });
  }

  /* ---------- Horloge lissée (défilement fluide de l'onde) ---------- */
  const clock = { base: 0, perf: 0, raw: -1 };
  function mediaTime() {
    const t = audio.currentTime || 0;
    const now = performance.now();
    if (audio.paused || audio.seeking || audio.readyState < 3) {
      clock.base = t; clock.perf = now; clock.raw = t;
      return t;
    }
    const pred = clock.base + (now - clock.perf) / 1000 * audio.playbackRate;
    if (Math.abs(pred - t) > 0.25) { clock.base = t; clock.perf = now; clock.raw = t; return t; }
    if (t !== clock.raw) {
      clock.raw = t;
      clock.base = pred + (t - pred) * 0.15;
      clock.perf = now;
      return clock.base;
    }
    return pred;
  }

  /* ---------- Gestes sur l'onde ---------- */
  const G = { pts: new Map(), mode: null, x0: 0, pos0: 0, pos: 0, span0: 0, dist0: 1, marker: null };

  function displayPos() {
    if (G.mode === 'pan') return G.pos;
    let t = mediaTime();
    if (VIEW.anim) {
      const k = (performance.now() - VIEW.anim.start) / 260;
      if (k >= 1) VIEW.anim = null;
      else t += (VIEW.anim.from - VIEW.anim.to) * Math.pow(1 - k, 3);
    }
    return t;
  }
  const wave = $('wave');
  const cssW = () => wave.getBoundingClientRect().width || 1;
  const viewStart = (p) => p - VIEW.cursor * VIEW.span;
  const timeAtX = (x, p) => viewStart(p) + (x / cssW()) * VIEW.span;
  const xOfTime = (t, p) => ((t - viewStart(p)) / VIEW.span) * cssW();

  let zoomTimer = 0;
  function setSpan(s) {
    const mx = maxSpan();
    VIEW.span = clamp(s, Math.min(VIEW.min, mx), mx);
    const chip = $('zoomChip');
    chip.textContent = VIEW.span >= mx - 0.05 ? 'Morceau entier' : (VIEW.span < 60 ? Math.round(VIEW.span) + ' s' : fmt(VIEW.span));
    chip.classList.add('show');
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => chip.classList.remove('show'), 900);
    dirty = true;
  }

  function userSeek(t) {
    // Aller hors du passage A–B pendant la boucle : on met la boucle en pause plutôt que de ramener à A.
    if (P.loop && P.A != null && P.B != null && (t < P.A - 0.05 || t > P.B)) {
      P.loop = false;
      renderLoop();
      toast('Boucle en pause');
    }
    audio.currentTime = t;
    dirty = true;
  }
  function animSeek(t) {
    const from = displayPos();
    userSeek(t);
    VIEW.anim = reduceMotion ? null : { from: from, to: t, start: performance.now() };
  }
  function moveMarker(which, t) {
    const d = dur();
    if (which === 'A') P.A = clamp(t, 0, (P.B != null ? P.B : d) - 0.2);
    else P.B = clamp(t, (P.A != null ? P.A : 0) + 0.2, d);
    renderLoop();
    dirty = true;
  }
  function pinchDist() {
    const a = Array.from(G.pts.values());
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
  }
  function commitPan() {
    const t = G.pos;
    G.mode = null;
    userSeek(t);
  }

  wave.addEventListener('pointerdown', (e) => {
    if (!P.hasTrack || !dur()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { wave.setPointerCapture(e.pointerId); } catch (err) { /* ignoré */ }
    G.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (G.pts.size === 1) {
      const r = wave.getBoundingClientRect(), x = e.clientX - r.left, p = displayPos();
      G.mode = 'pending'; G.x0 = e.clientX; G.pos0 = p; G.pos = p; G.marker = null;
      const tol = e.pointerType === 'mouse' ? 10 : 20;
      const da = P.A != null ? Math.abs(x - xOfTime(P.A, p)) : Infinity;
      const db = P.B != null ? Math.abs(x - xOfTime(P.B, p)) : Infinity;
      if (Math.min(da, db) < tol) G.marker = da <= db ? 'A' : 'B';
    } else if (G.pts.size === 2) {
      if (G.mode === 'pan') commitPan();
      G.mode = 'pinch';
      G.dist0 = pinchDist();
      G.span0 = VIEW.span;
    }
  });
  wave.addEventListener('pointermove', (e) => {
    const pt = G.pts.get(e.pointerId);
    if (!pt) return;
    pt.x = e.clientX; pt.y = e.clientY;
    if (G.mode === 'pinch' && G.pts.size >= 2) { setSpan(G.span0 * G.dist0 / pinchDist()); return; }
    if (G.pts.size !== 1) return;
    const dx = e.clientX - G.x0;
    if (G.mode === 'pending' && Math.abs(dx) > 6) G.mode = G.marker ? 'marker' : 'pan';
    if (G.mode === 'pan') {
      G.pos = clamp(G.pos0 - (dx / cssW()) * VIEW.span, 0, dur());
      dirty = true;
    } else if (G.mode === 'marker') {
      const r = wave.getBoundingClientRect();
      moveMarker(G.marker, clamp(timeAtX(e.clientX - r.left, displayPos()), 0, dur()));
    }
  });
  function endPointer(e, cancel) {
    if (!G.pts.has(e.pointerId)) return;
    G.pts.delete(e.pointerId);
    if (G.mode === 'pinch' || G.mode === 'after-pinch') {
      G.mode = G.pts.size ? 'after-pinch' : null;
      return;
    }
    if (G.pts.size) return;
    if (G.mode === 'pan') commitPan();
    else if (G.mode === 'pending' && !cancel) {
      const r = wave.getBoundingClientRect();
      animSeek(clamp(timeAtX(e.clientX - r.left, G.pos0), 0, dur()));
    }
    G.mode = null;
    dirty = true;
  }
  wave.addEventListener('pointerup', (e) => endPointer(e, false));
  wave.addEventListener('pointercancel', (e) => endPointer(e, true));
  wave.addEventListener('wheel', (e) => {
    if (!P.hasTrack || !dur()) return;
    e.preventDefault();
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) setSpan(VIEW.span * Math.exp(e.deltaY * 0.0025));
    else userSeek(clamp(displayPos() + (e.deltaX / cssW()) * VIEW.span, 0, dur()));
  }, { passive: false });

  /* ---------- Dessin de l'onde ---------- */
  const wctx = wave.getContext('2d');
  let W = 1, H = 1, DPR = 1;
  function sizeWave() {
    const r = wave.getBoundingClientRect();
    DPR = Math.min(3, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width * DPR));
    H = Math.max(1, Math.round(r.height * DPR));
    if (wave.width !== W || wave.height !== H) { wave.width = W; wave.height = H; }
    dirty = true;
  }
  if (window.ResizeObserver) new ResizeObserver(sizeWave).observe($('waveWrap'));
  window.addEventListener('resize', sizeWave);

  function drawWave(p) {
    const g = wctx;
    g.clearRect(0, 0, W, H);
    if (!P.hasTrack) return;
    const d = dur();
    const span = VIEW.span, v0 = viewStart(p);
    const tx = (t) => ((t - v0) / span) * W;
    const top = 26 * DPR, bot = H - 26 * DPR, cy = (top + bot) / 2, amp = (bot - top) / 2;
    const zone = P.zoneHex;
    const both = P.A != null && P.B != null;
    const ax = P.A != null ? tx(P.A) : null, bx = P.B != null ? tx(P.B) : null;

    // Ligne de base discrète sur toute la durée
    if (d) {
      g.fillStyle = 'rgba(255,255,255,0.07)';
      const l = Math.max(0, tx(0)), r = Math.min(W, tx(d));
      if (r > l) g.fillRect(l, cy - 0.5 * DPR, r - l, DPR);
    }

    // Passage sélectionné
    if (both) {
      const gr = g.createLinearGradient(ax, 0, bx, 0);
      const al = P.loop ? 0.2 : 0.12;
      gr.addColorStop(0, rgba(C.loopA, al));
      gr.addColorStop(1, rgba(C.loopB, al));
      g.fillStyle = gr;
      g.fillRect(ax, 0, bx - ax, H);
    }

    // Barres ancrées dans le temps (pas de scintillement au défilement)
    const pitch = 3 * DPR, bw = 2 * DPR;
    const bt = span / (W / pitch);
    if (d && bt > 0) {
      const k0 = Math.max(0, Math.floor(Math.max(0, v0) / bt));
      const k1 = Math.ceil(Math.min(d, v0 + span) / bt);
      const pk = P.peaks, pps = P.pps;
      for (let k = k0; k <= k1; k++) {
        const t = k * bt;
        if (t >= d) break;
        const x = tx(t);
        let v = 0.06;
        if (pk) {
          const s = Math.floor(t * pps), e = Math.min(pk.length, Math.max(s + 1, Math.ceil((t + bt) * pps)));
          v = 0;
          for (let i = s; i < e; i++) if (pk[i] > v) v = pk[i];
        }
        const h = Math.max(1.2 * DPR, v * amp);
        const tc = t + bt / 2;
        const inLoop = both && tc >= P.A && tc <= P.B;
        g.fillStyle = tc <= p ? zone : inLoop ? C.idleLoop : C.idle;
        if (g.roundRect) { g.beginPath(); g.roundRect(x, cy - h, bw, h * 2, bw / 2); g.fill(); }
        else g.fillRect(x, cy - h, bw, h * 2);
      }
    }

    drawMarker(ax, 'A');
    drawMarker(bx, 'B');
  }

  function drawMarker(x, which) {
    if (x == null || x < -200 * DPR || x > W + 200 * DPR) return;
    const g = wctx;
    const isA = which === 'A';
    const col = isA ? C.loopA : C.loopB;
    g.fillStyle = col;
    g.fillRect(Math.round(x - DPR), 0, 2 * DPR, H);
    // Étiquette « A — Début » en haut (vers la droite), « B — Fin » en bas (vers la gauche)
    const label = isA ? 'A — Début' : 'B — Fin';
    g.font = '800 ' + 10.5 * DPR + 'px Manrope, system-ui, sans-serif';
    const tw = g.measureText(label).width;
    const ph = 18 * DPR, pw = tw + 14 * DPR;
    let px = isA ? x - DPR : x + DPR - pw;
    const py = isA ? 6 * DPR : H - 6 * DPR - ph;
    // Si le curseur fixe passe sur l'étiquette, on la décale juste à côté pour qu'elle reste lisible
    const cur = VIEW.cursor * W, pad = 7 * DPR;
    if (cur > px - pad && cur < px + pw + pad) px = isA ? cur + pad : cur - pad - pw;
    g.beginPath();
    if (g.roundRect) g.roundRect(px, py, pw, ph, isA ? [2 * DPR, ph / 2, ph / 2, 2 * DPR] : [ph / 2, 2 * DPR, 2 * DPR, ph / 2]);
    else g.rect(px, py, pw, ph);
    g.fill();
    g.fillStyle = C.ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, px + pw / 2, py + ph / 2 + 0.5 * DPR);
  }

  /* ---------- Transport ---------- */
  function play() {
    if (!P.hasTrack) return;
    unlock();
    const t = audio.currentTime;
    if (P.loop && P.A != null && P.B != null && (t < P.A || t >= P.B - 0.05)) audio.currentTime = P.A;
    audio.playbackRate = P.speed / 100;
    const pr = audio.play();
    if (pr && pr.catch) pr.catch(() => toast('Lecture impossible pour ce fichier.'));
  }
  function togglePlay() { if (audio.paused) play(); else audio.pause(); }

  function renderPlay() {
    if (typeof updateSpinning === 'function') updateSpinning();
    const b = $('btnPlay');
    const playing = !audio.paused && !audio.ended;
    b.classList.toggle('is-playing', playing);
    b.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) { /* ignoré */ } }
  }

  function renderTransport() {
    const on = P.hasTrack;
    ['btnPlay', 'btnA', 'btnB', 'origBpm', 'removeBtn'].forEach((id) => { $(id).disabled = !on; });
    renderPlay();
  }

  function checkLoop() {
    if (P.loop && P.A != null && P.B != null && !audio.paused && G.mode !== 'pan' && audio.currentTime >= P.B) {
      audio.currentTime = P.A;
    }
  }

  function setMark(which) {
    if (!P.hasTrack) return;
    const t = G.mode === 'pan' ? G.pos : audio.currentTime, d = dur();
    if (which === 'A') {
      P.A = t;
      if (P.B != null && P.B <= P.A + 0.2) { P.B = null; P.loop = false; }
    } else {
      if (P.A == null) P.A = 0;
      if (t <= P.A + 0.2) {
        if (t < P.A - 0.2) { P.B = P.A; P.A = t; }
        else { toast('B doit être après A.'); return; }
      } else P.B = Math.min(t, d);
    }
    renderLoop();
    dirty = true;
  }

  function renderLoop() {
    const both = P.A != null && P.B != null;
    $('btnA').classList.toggle('set', P.A != null);
    $('btnB').classList.toggle('set', P.B != null);
    $('aTime').textContent = P.A != null ? fmt(P.A) : '';
    $('bTime').textContent = P.B != null ? fmt(P.B) : '';
    const lb = $('btnLoop');
    lb.disabled = !both;
    lb.setAttribute('aria-pressed', String(both && P.loop));
    lb.classList.toggle('ready', both && !P.loop);
    $('btnClear').disabled = P.A == null && P.B == null;
    const h = $('help');
    h.classList.toggle('ok', both);
    if (!P.hasTrack) h.textContent = '';
    else if (P.A == null) h.textContent = 'Place le début, puis touche A';
    else if (P.B == null) h.textContent = 'Place la fin, puis touche B';
    else if (!P.loop) h.textContent = 'Passage sélectionné — active la boucle';
    else h.innerHTML = 'Boucle active · <b>' + fmt(P.A) + '</b> → <b>' + fmt(P.B) + '</b>';
  }

  /* ---------- Vitesse ---------- */
  const zoneOf = (s) => (s === 100 ? 'normal' : s < 100 ? 'slow' : 'fast');
  function zoneHex(s) {
    if (s === 100) return C.gold;
    if (s < 100) return mixHex(C.slowLight, C.slowDeep, (100 - s) / 50);
    return mixHex(C.fastDeep, C.fastLight, (s - 100) / 50);
  }
  function setSpeed(v) {
    P.speed = clamp(Math.round(v), 50, 150);
    audio.defaultPlaybackRate = P.speed / 100;
    audio.playbackRate = P.speed / 100;
    const zone = zoneOf(P.speed);
    P.zoneHex = zoneHex(P.speed);
    const bs = document.body.style;
    document.body.dataset.zone = zone;
    bs.setProperty('--zone', P.zoneHex);
    bs.setProperty('--on-zone', lum(P.zoneHex) > 0.32 ? C.ink : '#FFFFFF');
    bs.setProperty('--zone-tint', zone === 'normal' ? 'rgba(0,0,0,0)' : rgba(P.zoneHex, 0.085));
    bs.setProperty('--zone-a', rgba(P.zoneHex, 0.4));
    bs.setProperty('--zone-glow', rgba(P.zoneHex, zone === 'normal' ? 0.075 : 0.13));
    $('speedVal').textContent = P.speed + ' %';
    $('zoneLbl').textContent = zone === 'normal' ? 'Normal' : zone === 'slow' ? 'Ralenti' : 'Accéléré';
    const s = $('speed');
    if (+s.value !== P.speed) s.value = P.speed;
    const pct = P.speed - 50;
    s.style.setProperty('--lo', Math.min(50, pct) + '%');
    s.style.setProperty('--hi', Math.max(50, pct) + '%');
    $('spReset').disabled = P.speed === 100;
    if (typeof renderSpeedWitness === 'function') renderSpeedWitness();
    $('spMinus').disabled = P.speed <= 50;
    $('spPlus').disabled = P.speed >= 150;
    renderBpm();
    dirty = true;
  }

  /* ---------- Volet du ralentisseur (fermé à chaque ouverture de l'appli) ---------- */
  let tempoOpen = false;
  function renderSpeedWitness() {
    const off = P.speed !== 100;
    const w = $('speedWitness');
    w.hidden = tempoOpen || !off;
    w.textContent = P.speed + ' %';
    player.classList.toggle('speed-off', off && !tempoOpen);
    $('radioLabel').classList.toggle('lit', tempoOpen);
  }
  function setTempoOpen(open) {
    if (open === tempoOpen) {
      // Le bouton « inutile » tourne quand même un peu : il répond au toucher
      const k = open ? $('knobOpen') : $('knobClose');
      if (!reduceMotion && k.animate) k.animate([{ transform: k.style.transform || 'none' }, { transform: 'rotate(' + (open ? 20 : -20) + 'deg)' }, { transform: k.style.transform || 'none' }], { duration: 300 });
      return;
    }
    tempoOpen = open;
    $('tempoWrap').classList.toggle('open', open);
    player.classList.toggle('tempo-open', open);
    $('knobOpen').classList.toggle('turned', open);
    $('knobOpen').setAttribute('aria-expanded', String(open));
    $('knobOpen').setAttribute('aria-disabled', String(open));
    $('knobClose').setAttribute('aria-disabled', String(!open));
    renderSpeedWitness();
    dirty = true;
    // Panneau entièrement visible : si −5 / curseur / +5 sortent de l'écran, on fait défiler juste ce qu'il faut
    if (open) setTimeout(() => {
      if (!tempoOpen) return;
      const r = $('tempo').getBoundingClientRect(), vh = window.innerHeight || document.documentElement.clientHeight;
      if (r.bottom > vh - 8 || r.top < 0) $('tempo').scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
    }, 520);
  }
  $('knobOpen').addEventListener('click', () => { hideSpeedHint(); setTempoOpen(true); });

  /* Aide discrète au ralentisseur : au tout premier morceau importé, le bouton gauche
     s'illumine trois fois et une petite bulle « Vitesse » apparaît. Une seule fois. */
  let hintTimer = 0;
  function showSpeedHint() {
    if (store.get('hintSpeed', false) || tempoOpen) return;
    store.set('hintSpeed', true);
    const k = $('knobOpen'), h = $('knobHint');
    k.classList.add('hint');
    h.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideSpeedHint, 6000);
  }
  function hideSpeedHint() {
    clearTimeout(hintTimer);
    $('knobOpen').classList.remove('hint');
    $('knobHint').hidden = true;
  }

  /* Installation de l'application (PWA).
     Bouton visible dès l'ouverture, masqué seul après 60 s, jamais affiché dans l'appli installée.
     Si le navigateur le permet (Chrome, Edge, Samsung Internet… sur Android et PC), le bouton ouvre
     directement la fenêtre d'installation native (beforeinstallprompt). Sinon seulement : instructions
     courtes adaptées au navigateur. Une fois installée, le bouton et le lien disparaissent. */
  const isStandalone = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const UA = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferredPrompt = null, pillTimer = 0, promptWaiters = [];
  const pill = $('installPill'), installSheet = $('installSheet');
  const markInstalled = () => { store.set('installed', true); hidePill(); $('installLink').hidden = true; };
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    // Le navigateur propose l'installation : l'appli n'est donc pas (ou plus) installée
    if (store.get('installed', false)) store.set('installed', false);
    if (!isStandalone()) $('installLink').hidden = false;
    promptWaiters.splice(0).forEach((f) => f(e));
  });
  window.addEventListener('appinstalled', () => { markInstalled(); toast('Application installée'); });
  function hidePill() {
    clearTimeout(pillTimer);
    pill.classList.remove('show');
    setTimeout(() => { pill.hidden = true; }, 450);
  }
  // Instructions de secours, une seule courte liste selon le navigateur
  function installSteps() {
    const and = /Android/i.test(UA);
    if (/; wv\)|FBAN|FBAV|Instagram|Line\//.test(UA)) return ['Touche <b>⋮</b> ou <b>⋯</b> puis <b>« Ouvrir dans le navigateur »</b>.', 'Dans Chrome, touche de nouveau <b>Installer l\'application</b>.'];
    if (/SamsungBrowser/i.test(UA)) return ['Touche le menu <b>≡</b> en bas de l\'écran.', 'Choisis <b>« Ajouter la page à »</b> puis <b>« Écran d\'accueil »</b>.'];
    if (/Firefox|FxiOS/i.test(UA)) return and
      ? ['Touche le menu <b>⋮</b>.', 'Choisis <b>« Installer »</b> ou <b>« Ajouter à l\'écran d\'accueil »</b>.']
      : ['Firefox sur ordinateur ne sait pas installer d\'application.', 'Ouvre <b>quartdetemps.fr</b> dans <b>Chrome</b> ou <b>Edge</b>, puis touche <b>Installer l\'application</b>.'];
    if (and) return ['Touche le menu <b>⋮</b> en haut à droite.', 'Choisis <b>« Installer l\'application »</b> ou <b>« Ajouter à l\'écran d\'accueil »</b>.'];
    if (/Safari/.test(UA) && !/Chrome|Chromium|Edg\//.test(UA)) return ['Menu <b>Fichier</b> de Safari.', 'Choisis <b>« Ajouter au Dock »</b>.'];
    return ['Clique sur l\'icône d\'installation <b>⊕</b> à droite de la barre d\'adresse,', 'ou menu <b>⋮</b> / <b>⋯</b> › <b>« Installer Quart de temps »</b>.'];
  }
  function openInstallSheet() {
    $('installIOS').hidden = !isIOS;
    $('installOther').hidden = isIOS;
    if (!isIOS) $('installOther').innerHTML = installSteps().map((t) => '<li>' + t + '</li>').join('');
    installSheet.hidden = false;
    void installSheet.offsetWidth;
    installSheet.classList.add('open');
  }
  function closeInstallSheet() {
    installSheet.classList.remove('open');
    setTimeout(() => { if (!installSheet.classList.contains('open')) installSheet.hidden = true; }, reduceMotion ? 0 : 320);
  }
  async function doInstall() {
    // Le navigateur peut annoncer l'installation un instant après le chargement : on l'attend brièvement
    // (le toucher reste valable quelques secondes pour ouvrir la fenêtre native).
    let p = deferredPrompt;
    if (!p && !isIOS) p = await new Promise((res) => { promptWaiters.push(res); setTimeout(() => res(null), 1200); });
    if (!p) { openInstallSheet(); return; }
    deferredPrompt = null;
    try {
      await p.prompt();
      const r = await p.userChoice;
      if (r && r.outcome === 'accepted') markInstalled();
    } catch (e) { openInstallSheet(); }
  }
  $('installBtn').addEventListener('click', doInstall);
  $('installLink').addEventListener('click', doInstall);
  $('installClose').addEventListener('click', () => { store.set('installBarOff', Date.now()); hidePill(); });
  installSheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeInstallSheet(); });
  if (!isStandalone() && !store.get('installed', false)) {
    $('installLink').hidden = false;
    pill.dataset.os = isIOS ? 'ios' : 'std';
    // Bandeau d'accueil en haut de l'écran, après l'ouverture animée ; fermé, il ne revient qu'après 14 jours
    if (Date.now() - store.get('installBarOff', 0) > 14 * 864e5) {
      setTimeout(() => {
        if (isStandalone() || store.get('installed', false)) return;
        pill.hidden = false;
        void pill.offsetWidth;
        pill.classList.add('show');
      }, 3800);
    }
  }
  // Android/Chrome : appli déjà installée sur l'appareil ? On masque tout.
  if (!isStandalone() && navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps().then((apps) => { if (apps && apps.length) markInstalled(); }).catch(() => {});
  }

  /* Mode allégé automatique pour les appareils modestes (moins de flou et d'animations de fond) */
  if ((navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 3) document.body.classList.add('lite');
  $('knobClose').addEventListener('click', () => {
    const k = $('knobClose');
    if (tempoOpen) { k.classList.add('turned'); setTimeout(() => k.classList.remove('turned'), 520); }
    setTempoOpen(false);
  });

  /* ---------- BPM ---------- */
  function playBpm() { return P.bpm ? Math.round(P.bpm * P.speed / 100) : null; }
  function renderBpm() {
    const inp = $('origBpm');
    const loading = player.dataset.state === 'loading';
    if (document.activeElement !== inp) inp.value = P.bpm ? fmtBpm(P.bpm) : '';
    inp.placeholder = loading ? '…' : '—';
    const pb = playBpm();
    $('playBpm').textContent = pb ? String(pb) : (loading ? '…' : '—');
  }
  function commitOrig() {
    const raw = String($('origBpm').value).replace(',', '.').trim();
    if (raw === '') { renderBpm(); return; }
    const v = parseFloat(raw);
    if (isFinite(v) && v >= 20 && v <= 300) P.bpm = Math.round(v * 10) / 10;
    else toast('Entre un BPM entre 20 et 300.');
    renderBpm();
  }

  /* ===================================================================== */
  /*                              MÉTRONOME                                 */
  /* ===================================================================== */
  const BEAT_NAMES = ['muet', 'normal', 'accentué'];
  /* Mesure : 1 à 12 temps, unité 2, 4 ou 8. En /8, les temps se groupent (6/8 = 3+3, 7/8 = 2+2+3…). */
  const NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], DENS = [2, 4, 8];
  function groupsFor(n, d) {
    if (d !== 8 || n <= 3) return [n];
    const special = { 4: [2, 2], 5: [3, 2], 7: [2, 2, 3], 8: [3, 3, 2], 10: [3, 3, 2, 2], 11: [3, 3, 3, 2] };
    if (special[n]) return special[n];
    return Array(n / 3).fill(3);
  }
  function defaultPattern(n) {
    // 0 = muet, 1 = normal, 2 = accentué. Par défaut : aucun accent, tous les temps identiques
    // (même volume, même hauteur). Les accents se posent à la main sur les voyants.
    return Array(n).fill(1);
  }
  // Réglages de travail : toujours les mêmes à l'ouverture (121 BPM, 4/4, noire, sans accent, arrêté).
  // Seules les préférences personnelles (volume, 33/45 tours, son) sont gardées en mémoire.
  const SOUNDS = ['cowbell', 'clave', 'wood', 'conga'];
  const metro = {
    bpm: 121,
    sub: 1,
    vol: clamp(+store.get('vol', 80), 0, 100),
    n: 4,
    d: 4,
    rpm: +store.get('rpm', 33) === 45 ? 45 : 33,
    // Nouvel ordre (Cloche en premier) : une fois pour tous, on repart sur la Cloche
    sound: (store.get('soundOrder', 0) >= 2 && SOUNDS.indexOf(store.get('sound', 'cowbell')) >= 0) ? store.get('sound', 'cowbell') : 'cowbell',
    muted: false, // temporaire : jamais gardé en mémoire
    pattern: defaultPattern(4, 4),
    running: false,
    nextTime: 0,
    beat: 0,
    subIdx: 0,
    pendingSub: null,
    sources: [],
    queue: []
  };
  // Le bouton Mute coupe le son du métronome (fondu court) sans arrêter l'animation des temps
  function volToGain(v) { return metro.muted ? 0 : Math.pow(v / 100, 2); }

  /* Clics synthétisés une fois pour toutes : accent (aigu, brillant), temps (franc), subdivision (plus doux). */
  function makeClicks(c) {
    const sr = c.sampleRate;
    function synth(freq, ratio, decay, gain, noiseAmt, len) {
      const n = Math.floor(sr * len), b = c.createBuffer(1, n, sr), d = b.getChannelData(0);
      let seed = 12345;
      const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const att = Math.min(1, i / (sr * 0.0012));
        const env = Math.exp(-t * decay) * att;
        let v = Math.sin(2 * Math.PI * freq * t) + 0.45 * Math.sin(2 * Math.PI * freq * ratio * t) * Math.exp(-t * decay * 1.6);
        if (t < 0.006) v += rnd() * noiseAmt * (1 - t / 0.006);
        d[i] = v * env;
        if (Math.abs(d[i]) > peak) peak = Math.abs(d[i]);
      }
      const k = gain / (peak || 1);
      for (let i = 0; i < n; i++) d[i] *= k;
      return b;
    }
    return {
      one: synth(1760, 2.76, 38, 1.0, 0.9, 0.12),
      beat: synth(1240, 2.76, 52, 0.88, 0.6, 0.09),
      sub: synth(1100, 2.76, 64, 0.5, 0.35, 0.07), // un ton plus grave que le temps, un peu plus doux
      // accent d'un autre temps que le 1 : marqué, mais distinct du 1
      acc: synth(1480, 2.76, 44, 0.95, 0.75, 0.11)
    };
  }

  /* Horloge dans un worker : les timers y sont moins ralentis que sur la page. */
  let tickWorker = null, tickFallback = 0;
  function startTicker() {
    try {
      if (!tickWorker) {
        const src = 'var id=0;onmessage=function(e){if(e.data==="start"){if(!id)id=setInterval(function(){postMessage(0)},20);}else{clearInterval(id);id=0;}};';
        tickWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        tickWorker.onmessage = scheduler;
      }
      tickWorker.postMessage('start');
    } catch (e) {
      tickFallback = setInterval(scheduler, 20);
    }
  }
  function stopTicker() {
    if (tickWorker) tickWorker.postMessage('stop');
    if (tickFallback) { clearInterval(tickFallback); tickFallback = 0; }
  }

  const LOOKAHEAD = 0.16;
  function scheduler() {
    if (!metro.running || !ctx) return;
    const now = ctx.currentTime;
    if (metro.nextTime < now - 0.05) {
      // La page a été suspendue : on se recale sans rafale de clics.
      metro.nextTime = now + 0.05;
      metro.subIdx = 0;
    }
    while (metro.nextTime < now + LOOKAHEAD) {
      if (metro.subIdx === 0 && metro.pendingSub) { metro.sub = metro.pendingSub; metro.pendingSub = null; }
      const isBeat = metro.subIdx === 0;
      if (metro.beat >= metro.pattern.length) metro.beat = 0;
      const st = metro.pattern[metro.beat];
      if (st !== 0) {
        const src = playMetroNote(metro.nextTime, isBeat, st, metro.beat === 0);
        metro.sources.push({ src: src, t: metro.nextTime });
      }
      metro.queue.push({ t: metro.nextTime, beat: metro.beat, isBeat: isBeat, st: st });
      metro.nextTime += 60 / metro.bpm / metro.sub;
      metro.subIdx++;
      if (metro.subIdx >= metro.sub) { metro.subIdx = 0; metro.beat = (metro.beat + 1) % metro.pattern.length; }
    }
    if (metro.sources.length > 48) metro.sources = metro.sources.filter((s) => s.t > now - 0.3);
    if (metro.queue.length > 64) metro.queue.splice(0, metro.queue.length - 64);
  }

  async function startMetro() {
    getCtx();
    await unlock();
    metro.running = true;
    store.set('started', true); $('mToggle').classList.remove('invite');   // le Play cesse de « respirer » dès le premier départ
    metro.beat = 0;
    metro.subIdx = 0;
    if (metro.pendingSub) { metro.sub = metro.pendingSub; metro.pendingSub = null; }
    metro.nextTime = ctx.currentTime + 0.08;
    metro.queue = [];
    SPARK.bar = 0;
    SPARK.k = -1;
    CR.started = false;
    scheduler();
    startTicker();
    renderMetroToggle();
    updateWake();
  }
  function stopMetro() {
    metro.running = false;
    stopTicker();
    if (ctx) {
      const now = ctx.currentTime;
      metro.sources.forEach((s) => { if (s.t > now) { try { s.src.stop(); } catch (e) { /* déjà fini */ } } });
    }
    metro.sources = [];
    metro.queue = [];
    lightBeat(-1);
    renderMetroToggle();
    updateWake();
  }
  function toggleMetro() { if (metro.running) stopMetro(); else startMetro(); }

  /* Étincelle : un point de lumière qui emprunte le sillon, sillon après sillon.
     Elle part au ras de l'étiquette, fait un tour par temps (elle passe en haut du disque à chaque clic),
     s'écarte d'un sillon à chaque tour (3,4 px, l'écart réel des sillons dessinés),
     s'éteint au bord et repart du premier sillon. Éclat sur le 1. */
  const GROOVE = 3.4;
  const sparkCv = $('spark'), sparkCtx = sparkCv.getContext('2d');
  const sparkGeom = { cx: 0, cy: 0, w: 1, h: 1, r0: 80, r1: 200, dpr: 1 };
  const SPARK = { lastT: 0, k: -1, bar: 0, parts: [], burst: 0, drawn: false, last: 0, stars: [], nextStar: 3 };
  // Palettes de lumière : 33 tours (couchant et bleu nuit) / 45 tours (lampe d'ampli : cuivre, ambre, champagne)
  const PAL = {
    33: { tail: [255, 95, 140], mid: [255, 180, 90], head: [140, 215, 255], first: [255, 175, 70], beat: [120, 205, 255], alt: [255, 130, 160] },
    45: { tail: [196, 92, 58], mid: [255, 150, 72], head: [255, 222, 160], first: [255, 138, 61], beat: [255, 200, 120], alt: [232, 140, 130] }
  };
  const pal = () => PAL[metro.rpm] || PAL[33];
  const sparkTurns = () => Math.max(4, Math.floor((sparkGeom.r1 - sparkGeom.r0) / GROOVE));
  function sizeSpark() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    sparkGeom.dpr = dpr;
    const w = Math.max(1, Math.round(sparkGeom.w * dpr)), h = Math.max(1, Math.round(sparkGeom.h * dpr));
    if (sparkCv.width !== w || sparkCv.height !== h) { sparkCv.width = w; sparkCv.height = h; }
  }
  function sparkPos(u) {
    const g = sparkGeom;
    const r = g.r0 + GROOVE * u;
    const a = -Math.PI / 2 + 2 * Math.PI * u;
    return [g.cx + r * Math.cos(a), g.cy + r * Math.sin(a), r];
  }
  function sparkProgress(now) {
    const ph = clamp((now - SPARK.lastT) / (60 / metro.bpm), 0, 1.1);
    return Math.max(0, SPARK.k) + ph;
  }
  function sparkBeat(ev, now) {
    if (reduceMotion) return;
    // Un tour par temps ; arrivée au bord, retour au premier sillon
    SPARK.lastT = ev.t;
    SPARK.k = SPARK.k + 1 >= sparkTurns() ? 0 : SPARK.k + 1;
    SPARK.bar = 1;
    if (ev.st === 0) return;
    if (ev.beat === 0) DUST.breath = 1;                  // le tourbillon « respire » sur chaque 1
    if (--SPARK.nextStar <= 0) {                         // une étoile filante toutes les 2 ou 3 mesures
      spawnStar();
      SPARK.nextStar = (metro.pattern.length || 4) * (Math.random() < 0.5 ? 2 : 3);
    }
  }
  /* Étoile filante : file sur un seul sillon, sur environ un quart de tour, plus vite quand le tempo monte */
  function spawnStar() {
    const g = sparkGeom;
    const span = Math.max(6, g.r1 - g.r0 - 12);
    SPARK.stars.push({
      r: g.r0 + 8 + Math.random() * span,
      a0: Math.random() * Math.PI * 2,
      arc: (Math.PI / 2) * (0.85 + Math.random() * 0.4),
      t0: performance.now(),
      dur: Math.min(900, Math.max(260, 60000 / metro.bpm * 0.85))
    });
  }
  const lerp3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  const rgbaS = (c, a) => 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a.toFixed(3) + ')';
  function drawSpark() {
    const running = metro.running && ctx && SPARK.bar > 0 && !reduceMotion;
    if (!running && !SPARK.parts.length) {
      if (SPARK.drawn) { sparkCtx.setTransform(1, 0, 0, 1, 0, 0); sparkCtx.clearRect(0, 0, sparkCv.width, sparkCv.height); SPARK.drawn = false; }
      SPARK.last = 0;
      return;
    }
    const c = sparkCtx, g = sparkGeom;
    const tms = performance.now(), dt = Math.min(0.05, SPARK.last ? (tms - SPARK.last) / 1000 : 0.016);
    SPARK.last = tms;
    c.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    c.clearRect(0, 0, g.w, g.h);
    c.globalCompositeOperation = 'lighter';
    SPARK.drawn = true;
    if (running) {
      const P = pal();
      for (let i = SPARK.stars.length - 1; i >= 0; i--) {
        const st = SPARK.stars[i], p = (tms - st.t0) / st.dur;
        if (p < 0) continue;
        if (p > 1.45) { SPARK.stars.splice(i, 1); continue; }
        const k = Math.min(1, p), ease = 1 - Math.pow(1 - k, 2);
        const head = st.a0 + st.arc * ease;
        const fade = p > 1 ? 1 - (p - 1) / 0.45 : 1;
        const tail = Math.max(st.a0, head - st.arc * 0.55);
        const N = 26;
        c.lineCap = 'round';
        for (let j = 0; j < N; j++) {
          const t1 = tail + (head - tail) * (j / N), t2 = tail + (head - tail) * ((j + 1) / N), q = (j + 1) / N;
          c.strokeStyle = rgbaS(lerp3(P.tail, P.head, q), 0.85 * q * q * fade);
          c.lineWidth = 0.4 + 1.5 * q;
          c.beginPath();
          c.arc(g.cx, g.cy, st.r, t1, t2);
          c.stroke();
        }
        const hx = g.cx + st.r * Math.cos(head), hy = g.cy + st.r * Math.sin(head);
        const gr = c.createRadialGradient(hx, hy, 0, hx, hy, 6);
        gr.addColorStop(0, 'rgba(255,255,255,' + (0.9 * fade).toFixed(3) + ')');
        gr.addColorStop(0.35, rgbaS(P.head, 0.6 * fade));
        gr.addColorStop(1, rgbaS(P.head, 0));
        c.fillStyle = gr;
        c.beginPath(); c.arc(hx, hy, 6, 0, Math.PI * 2); c.fill();
      }
    } else if (SPARK.stars.length) SPARK.stars.length = 0;
    // Particules
    for (let i = SPARK.parts.length - 1; i >= 0; i--) {
      const q = SPARK.parts[i];
      q.life -= dt * q.decay;
      if (q.life <= 0) { SPARK.parts.splice(i, 1); continue; }
      q.vx *= 0.96; q.vy *= 0.96;
      q.x += q.vx * dt; q.y += q.vy * dt;
      c.fillStyle = 'rgba(' + q.col[0] + ',' + q.col[1] + ',' + q.col[2] + ',' + (q.life * 0.6).toFixed(3) + ')';
      c.beginPath();
      c.arc(q.x, q.y, q.size * (0.5 + q.life * 0.6), 0, Math.PI * 2);
      c.fill();
    }
    if (SPARK.parts.length > 260) SPARK.parts.splice(0, SPARK.parts.length - 260);
    c.globalCompositeOperation = 'source-over';
  }

  /* Le vinyle : centré sur l'étiquette Tempo, il démarre et s'arrête comme une platine */
  const recordEl = $('record'), recordDisc = $('recordDisc'), metroEl = $('metro'), tempoWinEl = $('tempoWin');
  let DISC = 0.85, fitTries = 0, fitLocked = false, fitW = window.innerWidth;      // échelle du disque : 0,85 au plus, réduite si l'écran est trop court

  /* Le tourbillon de poussière d'or (hommage aux tourbillons d'eau de Léonard).
     Au Play, le chiffre se dissout et des grains de lumière montent du centre du disque en entonnoir,
     en perspective : ils viennent vers l'œil, grossissent, deviennent flous et peuvent déborder du cadre.
     Il tourne au tempo et « respire » sur chaque 1. À l'arrêt, la poussière retombe et le chiffre se reforme. */
  const DUST = { cv: null, c: null, sprite: null, ps: [], mode: 'off', breath: 0, last: 0, was: false, w: 0, h: 0, dpr: 1 };
  function dustSprite(col) {
    const sp = document.createElement('canvas'); sp.width = sp.height = 64;
    const g = sp.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.22, 'rgba(' + col + ',.95)');
    gr.addColorStop(0.55, 'rgba(' + col + ',.28)');
    gr.addColorStop(1, 'rgba(' + col + ',0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return sp;
  }
  function dustInit() {
    DUST.cv = $('dust');
    if (!DUST.cv) return;
    DUST.c = DUST.cv.getContext('2d');
    DUST.sprites = { 33: dustSprite('242,208,138'), 45: dustSprite('255,190,110') };
  }
  function dustSize() {
    // le calque vit dans le cadre du métronome : il défile avec le disque, d'un seul bloc, sans retard ni étirement
    if (DUST.cv.parentNode !== metroEl) metroEl.appendChild(DUST.cv);
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = metroEl.offsetWidth, h = metroEl.offsetHeight;
    if (DUST.w !== w || DUST.h !== h || DUST.dpr !== dpr) {
      DUST.w = w; DUST.h = h; DUST.dpr = dpr;
      DUST.cv.width = Math.round(w * dpr); DUST.cv.height = Math.round(h * dpr);
    }
  }
  function dustSpawn(fromLabel) {
    // h : hauteur dans l'entonnoir (0 = centre du disque, 1 = sommet) ; th : angle ; tw : scintillement
    return { h: fromLabel ? Math.random() * 0.15 : 0, th: Math.random() * Math.PI * 2, r0: 3 + Math.random() * (fromLabel ? 30 : 9),
      v: 0.2 + Math.random() * 0.22, s: 0.5 + Math.random() * 0.7, tw: Math.random() * 6.28, px: null, py: null, fall: 0, vy: 0 };
  }
  /* Petite galaxie spirale d'or au cœur du disque (vue un peu inclinée) : la tornade naît de son centre.
     Elle apparaît au Play, tourne lentement, puis s'efface à l'arrêt. */
  const GAL = { stars: [], vis: 0, rot: 0 };
  (function makeGalaxy() {
    for (let i = 0; i < 260; i++) {
      const arm = i % 3, t = Math.random();
      const r = 6 + 50 * Math.pow(t, 0.8);
      const th = arm * (Math.PI * 2 / 3) + t * 3.4 + (Math.random() - 0.5) * (0.55 - 0.3 * t);
      GAL.stars.push({ r: r + (Math.random() - 0.5) * 5, th, s: 0.35 + Math.random() * 0.75, tw: Math.random() * 6.28 });
    }
  })();
  const SKY = { far: [], mid: [], near: [], shoot: null, nextShoot: 0 };
  (function makeSky() {
    const pt = (n, s0, s1) => Array.from({ length: n }, () => ({ r: Math.sqrt(Math.random()), th: Math.random() * 6.283, s: s0 + Math.random() * (s1 - s0), tw: Math.random() * 6.283 }));
    SKY.far = pt(90, 0.35, 0.7); SKY.mid = pt(28, 0.6, 1.1); SKY.near = pt(9, 1.1, 1.8);
  })();
  // L'espace, uniquement dans le cercle du tempo : noir profond, nébuleuse, étoiles sur trois profondeurs, un peu de vie
  function drawSpace(c, cx, cy, R, now, vis, sprite) {
    if (vis <= 0) return;
    c.save();
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.clip();
    c.globalCompositeOperation = 'source-over';
    const bg = c.createRadialGradient(cx, cy, 0, cx, cy, R);
    bg.addColorStop(0, 'rgba(3,4,14,' + (0.96 * vis).toFixed(3) + ')');
    bg.addColorStop(0.75, 'rgba(6,8,26,' + (0.94 * vis).toFixed(3) + ')');
    bg.addColorStop(1, 'rgba(14,17,44,' + (0.85 * vis).toFixed(3) + ')');
    c.fillStyle = bg; c.fillRect(cx - R, cy - R, R * 2, R * 2);
    c.globalCompositeOperation = 'lighter';
    const neb = metro.rpm === 45 ? ['255,140,60', '232,140,130'] : ['120,80,220', '60,110,220'];
    [[-0.32, -0.18, 0.75, neb[0]], [0.3, 0.22, 0.65, neb[1]]].forEach(([ox, oy, rr, col]) => {
      const g = c.createRadialGradient(cx + ox * R, cy + oy * R, 0, cx + ox * R, cy + oy * R, rr * R);
      g.addColorStop(0, 'rgba(' + col + ',' + (0.2 * vis).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + col + ',0)');
      c.fillStyle = g; c.fillRect(cx - R, cy - R, R * 2, R * 2);
    });
    const layer = (arr, speed, bright, twinkle) => {
      for (const st of arr) {
        const th = st.th + GAL.rot * speed, rr = st.r * R;
        const x = cx + rr * Math.cos(th), y = cy + rr * Math.sin(th);
        const a = vis * bright * (twinkle ? 0.45 + 0.55 * Math.sin(now / 520 + st.tw) ** 2 : 0.85);
        const d = st.s * 3;
        c.globalAlpha = a;
        c.drawImage(sprite, x - d / 2, y - d / 2, d, d);
      }
    };
    layer(SKY.far, 0.08, 0.5, false);
    layer(SKY.mid, 0.25, 0.75, true);
    layer(SKY.near, 0.5, 1, true);
    // une étoile qui pulse doucement
    const pz = 0.5 + 0.5 * Math.sin(now / 900);
    c.globalAlpha = vis * (0.4 + 0.6 * pz);
    const pd = 4 + 4 * pz;
    c.drawImage(sprite, cx + 0.62 * R - pd / 2, cy - 0.5 * R - pd / 2, pd, pd);
    // de temps en temps, une minuscule étoile filante traverse le hublot
    if (!SKY.shoot && now > SKY.nextShoot) {
      const a0 = Math.random() * 6.283;
      SKY.shoot = { x: cx + Math.cos(a0) * R * 0.9, y: cy + Math.sin(a0) * R * 0.9, ang: a0 + Math.PI + (Math.random() - 0.5) * 0.9, t0: now };
      SKY.nextShoot = now + 6000 + Math.random() * 4000;
    }
    if (SKY.shoot) {
      const k = (now - SKY.shoot.t0) / 750;
      if (k > 1) SKY.shoot = null;
      else {
        const L = R * 1.6, e = 1 - Math.pow(1 - k, 1.6), hx = SKY.shoot.x + Math.cos(SKY.shoot.ang) * L * e, hy = SKY.shoot.y + Math.sin(SKY.shoot.ang) * L * e;
        const tl = 34 * Math.min(1, k * 4), tx = hx - Math.cos(SKY.shoot.ang) * tl, ty = hy - Math.sin(SKY.shoot.ang) * tl;
        const fade = vis * Math.min(1, (1 - k) * 2.5);
        const gr = c.createLinearGradient(tx, ty, hx, hy);
        gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,248,228,' + (0.9 * fade).toFixed(3) + ')');
        c.globalAlpha = 1; c.strokeStyle = gr; c.lineWidth = 1.4; c.lineCap = 'round';
        c.beginPath(); c.moveTo(tx, ty); c.lineTo(hx, hy); c.stroke();
        c.globalAlpha = 0.9 * fade; c.drawImage(sprite, hx - 3.5, hy - 3.5, 7, 7);
      }
    }
    drawComet(c, cx, cy, R, now, vis, sprite);
    c.globalAlpha = 1;
    c.restore();
  }
  /* Piste cachée, en quatre actes : à chaque minute de jeu sans interruption, une comète entre dans le hublot
     et trace un quart de cercle de plus (1, puis 2, puis 3 quarts). À la quatrième minute, le cercle se referme,
     la spirale à quatre centres se dessine au centre : le logo s'écrit dans le ciel, brille, puis se dissout.
     Ensuite plus rien jusqu'au prochain Play, où l'histoire recommence. */
  const COMET = { t0: 0, stage: 0, quarters: 1, T: 0, trail: [], dust: null, playT0: 0, spiral: null };
  function cometSpiral() {
    if (COMET.spiral) return COMET.spiral;
    const el = document.querySelector('#introLogo .il-spiral'), pts = [];
    try {
      const L = el.getTotalLength();
      for (let i = 0; i <= 160; i++) { const q = el.getPointAtLength(L * i / 160); pts.push([q.x / 90, q.y / 90]); }
    } catch (e) { /* pas de spirale : le cercle seul suffira */ }
    return (COMET.spiral = pts);
  }
  function cometFire(now) {
    if (COMET.stage >= 4) return;
    COMET.stage++;
    COMET.quarters = COMET.stage;
    COMET.t0 = now; COMET.trail = []; COMET.dust = null;
    COMET.T = 900 + 800 * COMET.quarters;                 // même vitesse à chaque passage : elle va juste plus loin
    if (COMET.stage === 4) cometSpiral();
  }
  function drawComet(c, cx, cy, R, now, vis, sprite) {
    if (!COMET.t0) return;
    const T = COMET.T, el = now - COMET.t0, full = COMET.quarters === 4;
    const end = T + (full ? 5600 : 1900);
    if (el > end) { COMET.t0 = 0; return; }
    const Rq = R * 0.6, span = COMET.quarters * Math.PI / 2, a0 = -Math.PI / 2, a1 = a0 + span;
    const P = (a) => [cx + Rq * Math.cos(a), cy + Rq * Math.sin(a)];
    const Tg = (a) => [-Math.sin(a), Math.cos(a)];
    const Lin = R * 0.9, Lar = Rq * span, Lout = R * 0.9, D = Lin + Lar + Lout;
    const at = (dist) => {
      if (dist < Lin) { const p0 = P(a0), t = Tg(a0), k = Lin - dist; return [p0[0] - t[0] * k, p0[1] - t[1] * k]; }
      if (dist < Lin + Lar) return P(a0 + (dist - Lin) / Rq);
      const p1 = P(a1), t = Tg(a1), k = dist - Lin - Lar; return [p1[0] + t[0] * k, p1[1] + t[1] * k];
    };
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round'; c.lineJoin = 'round';
    const u = Math.min(1, el / T), ease = u < 0.12 ? (u / 0.12) * (u / 0.12) * 0.06 : u > 0.88 ? 1 - ((1 - u) / 0.12) * ((1 - u) / 0.12) * 0.06 : 0.06 + (u - 0.12) / 0.76 * 0.88;
    const dist = D * ease * 0.999;
    const arcDone = Math.max(0, Math.min(1, (dist - Lin) / Lar));
    // l'arc qui se rallume sous la comète et reste suspendu
    const hold = full ? 3600 : 900;
    const arcA = el < T + hold ? 1 : Math.max(0, 1 - (el - T - hold) / 800);
    const glow = full && el > T ? Math.min(1, (el - T) / 500) * arcA : 0;
    const stroke = (fn, layers, k) => layers.forEach(([w, al]) => { c.strokeStyle = 'rgba(246,214,146,' + (al * k * vis).toFixed(3) + ')'; c.lineWidth = w; c.beginPath(); fn(); c.stroke(); });
    if (arcDone > 0 && arcA > 0) {
      const aEnd = a0 + arcDone * span;
      stroke(() => c.arc(cx, cy, Rq, a0, aEnd), [[7, 0.1 + 0.12 * glow], [2.6, 0.35 + 0.2 * glow], [1.1, 0.85]], arcA);
    }
    // grand final : la spirale à quatre centres s'écrit à l'encre d'or depuis le centre, le logo brille
    if (full && el > T + 200) {
      const pts = COMET.spiral || [], k = Math.min(1, (el - T - 200) / 1500), n = Math.floor(k * (pts.length - 1));
      if (n > 1 && arcA > 0) {
        const sc = Rq * 0.92;
        stroke(() => { c.moveTo(cx + pts[0][0] * sc, cy + pts[0][1] * sc); for (let i = 1; i <= n; i++) c.lineTo(cx + pts[i][0] * sc, cy + pts[i][1] * sc); }, [[6, 0.08 + 0.1 * glow], [2.4, 0.3 + 0.2 * glow], [1.1, 0.85]], arcA);
        if (k < 1) { const h = pts[n]; c.globalAlpha = vis; c.drawImage(sprite, cx + h[0] * sc - 6, cy + h[1] * sc - 6, 12, 12); }
      }
      if (el > T + 1700 && el < T + hold) {                 // éclat : quatre points de lumière aux quarts
        const g = Math.sin(Math.PI * Math.min(1, (el - T - 1700) / (hold - 1700)));
        for (let i = 0; i < 4; i++) {
          const ang = -Math.PI / 2 + i * Math.PI / 2, sz = 8 + 8 * g;
          c.globalAlpha = g * vis; c.drawImage(sprite, cx + Rq * Math.cos(ang) - sz / 2, cy + Rq * Math.sin(ang) - sz / 2, sz, sz);
        }
      }
    }
    // poussière d'étoiles quand le dessin s'efface (au final, elle retombe dans la galaxie)
    if (el > T + hold - 200) {
      if (!COMET.dust) {
        const pts = full ? (COMET.spiral || []) : [];
        COMET.dust = Array.from({ length: full ? 90 : 34 }, (_, i) => {
          if (full && i % 2 && pts.length) { const q = pts[(Math.random() * pts.length) | 0]; return { x: q[0] * Rq * 0.92, y: q[1] * Rq * 0.92, s: 0.5 + Math.random() }; }
          const a = a0 + Math.random() * span, r = Rq + (Math.random() - 0.5) * 6; return { x: r * Math.cos(a), y: r * Math.sin(a), s: 0.5 + Math.random() };
        });
      }
      const k = (el - T - hold + 200) / 1400;
      if (k < 1) for (const g of COMET.dust) {
        const pull = full ? 1 - 0.7 * k : 1 + 0.08 * k;      // au final, la poussière est aspirée par la galaxie
        c.globalAlpha = vis * (1 - k) * (0.5 + 0.5 * Math.sin(now / 90 + g.x) ** 2);
        const sz = g.s * 3.2; c.drawImage(sprite, cx + g.x * pull - sz / 2, cy + g.y * pull - sz / 2, sz, sz);
      }
    }
    // la comète : tête lumineuse et longue chevelure qui s'effile
    if (el < T) {
      COMET.trail.push(at(dist));
      if (COMET.trail.length > 42) COMET.trail.shift();
      const tr = COMET.trail;
      c.globalAlpha = 1;
      for (let i = 1; i < tr.length; i++) {
        const f = i / tr.length;
        c.strokeStyle = 'rgba(255,246,222,' + (0.8 * f * f * vis).toFixed(3) + ')';
        c.lineWidth = 0.5 + 4.4 * f;
        c.beginPath(); c.moveTo(tr[i - 1][0], tr[i - 1][1]); c.lineTo(tr[i][0], tr[i][1]); c.stroke();
      }
      const h = tr[tr.length - 1];
      c.globalAlpha = vis; c.drawImage(sprite, h[0] - 10, h[1] - 10, 20, 20);
      c.globalAlpha = vis * 0.9; c.drawImage(sprite, h[0] - 4, h[1] - 4, 8, 8);
    }
    c.globalAlpha = 1;
  }
  function drawGalaxy(c, cx, cy, now, dt, sprite, br) {
    if (GAL.vis <= 0) return;
    GAL.rot += dt * (0.25 + metro.bpm / 900);
    const flat = 0.56;                                   // inclinaison : un disque vu de biais
    // cœur lumineux
    const core = c.createRadialGradient(cx, cy, 0, cx, cy, 22);
    core.addColorStop(0, 'rgba(255,240,205,' + (0.55 * GAL.vis * (1 + 0.4 * br)).toFixed(3) + ')');
    core.addColorStop(1, 'rgba(242,208,138,0)');
    c.fillStyle = core;
    c.beginPath(); c.ellipse(cx, cy, 22, 22 * flat, 0, 0, Math.PI * 2); c.fill();
    for (const st of GAL.stars) {
      const th = st.th + GAL.rot * (1.2 - st.r / 80);
      const x = cx + st.r * Math.cos(th), y = cy + st.r * Math.sin(th) * flat;
      const a = GAL.vis * (0.35 + 0.65 * Math.sin(now / 400 + st.tw) ** 2) * (1 - st.r / 70);
      if (a <= 0.02) continue;
      const d = st.s * 3.4;
      c.globalAlpha = a;
      c.drawImage(sprite, x - d / 2, y - d / 2, d, d);
    }
    c.globalAlpha = 1;
  }
  function dustStart() {
    DUST.ps = [];                                          // plus de tornade au Play : la galaxie apparaît seule
    DUST.mode = 'on';
    DUST.t0 = performance.now();
    COMET.playT0 = DUST.t0; COMET.stage = 0; COMET.t0 = 0;  // l'histoire de la comète recommence à chaque Play
  }
  function dustStop() {
    DUST.mode = 'fall';
    DUST.ps.forEach((p) => { p.fall = 1; p.vy = -20 - Math.random() * 40; });
  }
  const UIF = { drag: false, skip: false };               // pendant le réglage du tempo, les animations de fond tournent à demi-cadence
  function drawDust() {
    if (UIF.drag && (UIF.skip = !UIF.skip)) return;
    const on = metro.running && !reduceMotion;
    if (on !== DUST.was) { DUST.was = on; if (on) dustStart(); else if (DUST.mode === 'on') dustStop(); }
    if (!DUST.c) return;
    if (DUST.mode === 'off') return;
    dustSize();
    const now = performance.now(), dt = Math.min(0.05, DUST.last ? (now - DUST.last) / 1000 : 0.016);
    DUST.last = now;
    const c = DUST.c;
    c.setTransform(DUST.dpr, 0, 0, DUST.dpr, 0, 0);
    c.clearRect(0, 0, DUST.w, DUST.h);
    const cx = sparkGeom.cx, cy = sparkGeom.cy;           // repère du cadre : plus besoin de suivre le défilement
    const spin = (metro.bpm / 60) * 0.75;                 // tours par seconde : suit le tempo, en douceur
    DUST.breath = Math.max(0, DUST.breath - dt * 2.2);
    const br = DUST.breath;
    const F = 700, H = 120, TILT = 0.42;                  // distance focale, hauteur de la tornade, légère inclinaison vers l'œil
    const RING = 172 * DISC - 4;                          // le tourbillon reste dans l'anneau doré
    const ct = Math.cos(TILT), st = Math.sin(TILT);
    const sprite = DUST.sprites[metro.rpm === 45 ? 45 : 33];
    const peek = tempoWinEl.classList.contains('peek') || tempoWinEl.classList.contains('editing');
    GAL.vis = Math.max(0, Math.min(1, GAL.vis + (DUST.mode === 'on' ? dt * 1.4 : -dt * 1.6)));
    const tr = tempoWinEl.getBoundingClientRect();
    drawSpace(c, cx, cy, tr.width / 2 - 3, now, GAL.vis * (peek ? 0.12 : 1), sprite);
    c.save();
    c.beginPath(); c.arc(cx, cy, RING, 0, Math.PI * 2); c.clip();
    c.globalCompositeOperation = 'lighter';
    if (peek) c.globalAlpha = 0.15;
    drawGalaxy(c, cx, cy, now, dt, sprite, br);
    let alive = 0;
    const age = now - (DUST.t0 || now), settle = age > 2300, tf = settle ? Math.max(0, 1 - (age - 2300) / 1100) : 1;
    if (DUST.mode === 'on' && settle && tf <= 0 && DUST.ps.length) DUST.ps = [];
    if (DUST.mode === 'on' && COMET.stage < 4 && now - COMET.playT0 > 60000) { COMET.playT0 = now; cometFire(now); }   // un acte à chaque minute de jeu
    for (const p of DUST.ps) {
      if (DUST.mode === 'on' && !settle) {
        p.h += p.v * dt * (0.8 + metro.bpm / 240);
        if (p.h > 1) Object.assign(p, dustSpawn(false), { px: null, py: null });
      } else if (DUST.mode === 'on') {
        p.h -= dt * (0.55 + p.v);                           // les grains redescendent et la galaxie les absorbe
        if (p.h <= 0 || tf <= 0) continue;
      } else {
        p.vy += 260 * dt; p.fall -= dt * 0.9;             // la poussière retombe dans le disque
        if (p.fall <= 0) continue;
      }
      alive++;
      if (p.h < 0) continue;
      p.th += spin * Math.PI * 2 * dt * (1.35 - 0.7 * p.h);
      const r = (p.r0 + 62 * Math.pow(p.h, 1.35)) * (1 + 0.22 * br);
      // repère 3D : l'axe de l'entonnoir monte et penche vers l'œil
      const x3 = r * Math.cos(p.th), z0 = r * Math.sin(p.th), y0 = -H * p.h;
      const y3 = y0 * ct - z0 * st, z3 = y0 * st + z0 * ct;
      const k = F / (F + z3);
      let sx = cx + x3 * k, sy = cy + y3 * k;
      if (DUST.mode === 'fall') sy += (p.vy * (1 - p.fall));
      const depth = Math.min(1.9, k);
      let a = Math.min(1, p.h * 6) * Math.min(1, (1 - p.h) * 3) * (0.55 + 0.45 * Math.sin(now / 180 + p.tw) ** 2) * (0.7 + 0.5 * br);
      if (DUST.mode === 'fall') a *= p.fall;
      else a *= tf;
      const size = p.s * 2.6 * depth * depth * (1 + 0.35 * br);
      const near = depth > 1.16;                           // grains les plus proches de l'œil : doux, hors mise au point
      // traînée de vitesse
      if (p.px !== null && !near && Math.abs(sx - p.px) + Math.abs(sy - p.py) < 22) {   // traînée courte, même si l'affichage saccade
        c.strokeStyle = metro.rpm === 45 ? 'rgba(255,190,110,' + (a * 0.35).toFixed(3) + ')' : 'rgba(242,208,138,' + (a * 0.35).toFixed(3) + ')';
        c.lineWidth = Math.max(0.6, size * 0.32);
        c.beginPath(); c.moveTo(p.px, p.py); c.lineTo(sx, sy); c.stroke();
      }
      c.globalAlpha = near ? a * 0.4 : a;
      const d = near ? size * 2.6 : size * 2;
      c.drawImage(sprite, sx - d / 2, sy - d / 2, d, d);
      c.globalAlpha = 1;
      p.px = sx; p.py = sy;
    }
    c.globalCompositeOperation = 'source-over';
    c.restore();
    if (DUST.mode === 'fall' && !alive && GAL.vis <= 0) { DUST.mode = 'off'; DUST.ps = []; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, DUST.cv.width, DUST.cv.height); }
  }
  dustInit();

  /* Petit logo « QUART DE TEMPS » dans le métronome (copie du logo de l'en-tête, sans ses identifiants) */
  (function buildMini() {
    const host = $('miniMark'), src = document.querySelector('.wordmark');
    if (!host || !src) return;
    const l1 = src.querySelector('.wm-line1').cloneNode(true), l2 = src.querySelector('.wm-line2').cloneNode(true);
    l1.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
    const gr = l1.querySelector('linearGradient');
    if (gr) { gr.setAttribute('id', 'wmBrassMini'); l1.querySelectorAll('[stroke="url(#wmBrass)"]').forEach((e) => e.setAttribute('stroke', 'url(#wmBrassMini)')); }
    host.appendChild(l1); host.appendChild(l2);
  })();

  /* Ouverture : la spirale se trace à l'encre d'or, le quart s'allume, le nom apparaît et le A-balancier oscille ;
     puis le logo s'envole jusqu'à sa petite place dans le métronome, qui se déploie à l'écran.
     Environ 2,5 s, un toucher la passe ; seulement à l'ouverture de l'appli. */
  (function intro() {
    const root = document.documentElement;
    if (!root.classList.contains('intro')) return;
    const top = $('top'), wm = top.querySelector('.wordmark'), logo = $('introLogo'), bg = $('introBg'), mini = $('miniMark');
    const sp = logo.querySelector('.il-spiral'), q = logo.querySelector('.il-quarter');
    const parts = [wm.querySelector('.wm-qu'), wm.querySelector('.wm-a'), wm.querySelector('.wm-rt'), wm.querySelector('.wm-line2'), wm.querySelector('.wm-rule'), wm.querySelector('.wm-devise')].filter(Boolean);
    let done = false, started = false;
    const timers = [];
    const later = (ms, fn) => timers.push(setTimeout(fn, ms));
    // état de départ : tout invisible, sans calcul coûteux
    parts.forEach((el) => { el.style.opacity = '0'; });
    const prep = (el) => { let L = 600; try { L = el.getTotalLength(); } catch (e) { /* défaut */ } el.style.strokeDasharray = L + ' ' + L; el.style.strokeDashoffset = String(L); return L; };
    const Ls = prep(sp), Lq = prep(q);
    function start() {
      if (started || done) return;
      started = true;
      sp.animate([{ strokeDashoffset: Ls }, { strokeDashoffset: 0 }], { duration: 900, delay: 60, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'forwards' });
      q.animate([{ strokeDashoffset: Lq }, { strokeDashoffset: 0 }], { duration: 420, delay: 700, easing: 'cubic-bezier(.45,.05,.3,1)', fill: 'forwards' });
      parts.forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: 520, delay: 600 + i * 130, easing: 'cubic-bezier(.3,.9,.3,1)', fill: 'forwards' }));
      const aSvg = wm.querySelector('.wm-a svg');
      if (aSvg) {
        aSvg.style.transformOrigin = '50% 0';
        aSvg.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-9deg)' }, { transform: 'rotate(7deg)' }, { transform: 'rotate(-3deg)' }, { transform: 'rotate(0)' }],
          { duration: 900, delay: 1100, easing: 'ease-in-out' });
      }
      later(2000, () => finish(false));
    }
    function finish(fast) {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      parts.forEach((el) => { el.style.opacity = ''; });
      const decks = document.querySelectorAll('.app > .deck');
      const end = () => {
        root.classList.remove('intro');
        [wm, logo, bg].forEach((el) => el.getAnimations().forEach((x) => x.cancel()));
        parts.forEach((el) => el.getAnimations().forEach((x) => x.cancel()));
        fitTries = 0; fitLocked = false;
        placeRecord();
      };
      if (fast) { end(); return; }
      const a = wm.getBoundingClientRect(), b = mini.getBoundingClientRect();
      const sc = b.width && a.width ? b.width / a.width : 0.3;
      const dx = (b.left + b.width / 2) - (a.left + a.width / 2), dy = (b.top + b.height / 2) - (a.top + a.height / 2);
      // le grand logo s'envole vers sa place en s'estompant presque entièrement
      wm.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + sc + ')', opacity: 0.06 }], { duration: 640, easing: 'cubic-bezier(.6,0,.25,1)', fill: 'forwards' });
      logo.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.6)' }], { duration: 420, easing: 'ease-in', fill: 'forwards' });
      bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 640, easing: 'ease-in', fill: 'forwards' });
      decks.forEach((d, i) => d.animate([{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }], { duration: 620, delay: 120 + i * 90, easing: 'cubic-bezier(.3,1.1,.4,1)', fill: 'backwards' }));
      // le petit logo apparaît à sa place avec un léger éclat doré
      mini.animate([{ opacity: 0, filter: 'drop-shadow(0 0 0 rgba(255,200,120,0))' }, { opacity: 1, filter: 'drop-shadow(0 0 9px rgba(255,200,120,.9))', offset: 0.45 }, { opacity: 1, filter: 'drop-shadow(0 0 0 rgba(255,200,120,0))' }],
        { duration: 760, delay: 560, easing: 'ease-out', fill: 'backwards' });
      setTimeout(end, 660);
    }
    top.addEventListener('pointerdown', () => finish(true), { once: true });
    // on attend les polices (sinon le texte « saute »), puis l'image suivante, pour un départ fluide
    const fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    Promise.race([fontsReady, new Promise((r) => setTimeout(r, 450))]).then(() => requestAnimationFrame(() => requestAnimationFrame(start)));
    later(3200, () => finish(false));                                   // filet de sécurité
  })();
  // Tempo gravé sur le disque pendant le jeu
  function renderMini() { const e = $('discTempoTxt'); if (e) e.textContent = metro.bpm + ' BPM'; }
  // Pendant la marche, toucher ±1 / ±5 rallume le chiffre le temps de le lire
  let peekTimer = 0;
  function peekTempo() {
    if (!metro.running) return;
    tempoWinEl.classList.add('peek');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => tempoWinEl.classList.remove('peek'), 1600);
  }
  function placeRecord() {
    const m = metroEl.getBoundingClientRect(), t = tempoWinEl.getBoundingClientRect();
    if (!m.width) return;
    const rx = t.left + t.width / 2 - m.left, ry = t.top + t.height / 2 - m.top;
    recordEl.style.setProperty('--rx', rx + 'px');
    recordEl.style.setProperty('--ry', ry + 'px');
    const dt = $('discTempo');
    if (dt) {
      dt.style.setProperty('--rx', rx + 'px'); dt.style.setProperty('--ry', ry + 'px');
      const R = Math.round(146 * DISC);                  // entre l'anneau doré et le sillon du milieu
      $('discArc').setAttribute('d', 'M ' + (-R) + ' 0 A ' + R + ' ' + R + ' 0 0 0 ' + R + ' 0');
    }
    // Rien ne touche le disque, sur tous les écrans : temps 1-2-3-4 au-dessus de l'anneau doré, commandes en dessous
    const RING = 172 * DISC + 3;
    const bx = $('beats').getBoundingClientRect(), gb = $('mToggle').getBoundingClientRect();
    const cyAbs = t.top + t.height / 2;
    const gapTop = (cyAbs - RING) - bx.bottom, gapBot = gb.top - (cyAbs + RING);
    const cs = getComputedStyle(metroEl);
    const curTop = parseFloat(cs.getPropertyValue('--beats-gap')) || 6, curRow = parseFloat(cs.getPropertyValue('--row-gap')) || 84;
    const wantTop = Math.max(6, Math.round(curTop + (12 - gapTop))), wantRow = Math.max(24, Math.round(curRow + (22 - gapBot)));
    if (Math.abs(wantTop - curTop) > 1 || Math.abs(wantRow - curRow) > 1) {
      metroEl.style.setProperty('--beats-gap', wantTop + 'px');
      metroEl.style.setProperty('--row-gap', wantRow + 'px');
      return requestAnimationFrame(placeRecord);           // on repositionne après ce réglage
    }
    // Le métronome tient dans l'écran dès l'ouverture : si les sons dépassent le bas, le disque se réduit un peu
    if (fitTries < 6 && !fitLocked) {
      const snd = metroEl.getBoundingClientRect();          // tout le cadre, biseau compris
      const excess = (snd.bottom + window.scrollY) + 6 - window.innerHeight;
      let want = DISC;
      if (excess > 2) want = Math.max(0.62, DISC - excess / 344);
      else if (excess < -24 && DISC < 0.85) want = Math.min(0.85, DISC + (-excess - 12) / 344);
      if (Math.abs(want - DISC) > 0.004) {
        DISC = want; fitTries++;
        metroEl.style.setProperty('--disc', DISC.toFixed(3));
        return requestAnimationFrame(placeRecord);
      }
      fitLocked = true;                                     // calé : le défilement (barre d'adresse qui va et vient) ne le change plus
    }
    placeArm(m, rx, ry);
  }
  /* Bras : pivot en haut à droite, rentré dans le pupitre ; en lecture, la tête se pose sur les
     sillons extérieurs, entre les boutons +1 et +5, à droite de l'étiquette — comme une vraie platine.
     Tout est calé sur les vrais boutons, donc juste sur chaque taille d'écran. */
  const armEl = $('tonearm'), taPath = $('taPath'), taHead = $('taHead'), taSvg = $('taSvg'), taRest = $('taRest');
  const deg = (r) => r * 180 / Math.PI;
  function placeArm(m, rx, ry) {
    const bs = $('beats').querySelectorAll('.beat');
    const box = $('beats').getBoundingClientRect();
    const lastB = bs.length ? bs[bs.length - 1].getBoundingClientRect() : box;
    const row = { left: box.left, right: lastB.right, top: box.top, bottom: box.bottom, width: lastB.right - box.left };
    const p1 = document.querySelector('.mctl .step[data-step="1"]').getBoundingClientRect();
    const p5 = document.querySelector('.mctl .step[data-step="5"]').getBoundingClientRect();
    const lab = tempoWinEl.getBoundingClientRect();
    const rel = (r) => ({ l: r.left - m.left, r: r.right - m.left, t: r.top - m.top, b: r.bottom - m.top, cx: r.left + r.width / 2 - m.left });
    const R = rel(row), P1 = rel(p1), P5 = rel(p5), L = rel(lab);
    // Pivot en haut à droite, juste sous la rangée des temps ; tête posée sur les sillons à droite de l'étiquette
    let px = m.width - 24, py = R.b + 18;
    const hx = L.r + 20, hy = (L.t + L.b) / 2 + 8;
    const tx = hx - px, ty = hy - py;
    // La tête est à (-10, len + 12) du pivot dans le dessin du bras
    const len = Math.max(60, Math.sqrt(Math.max(0, tx * tx + ty * ty - 100)) - 12);
    taPath.setAttribute('d', 'M0 -17V' + (len - 6) + 'Q0 ' + (len + 4) + ' -7 ' + (len + 11));
    taHead.setAttribute('transform', 'translate(-10 ' + (len + 17) + ') rotate(30)');
    taSvg.setAttribute('viewBox', '-22 -38 44 ' + (len + 70));
    taSvg.setAttribute('height', String(len + 70));
    const play = deg(Math.atan2(ty, tx) - Math.atan2(len + 12, -10));
    // Repos : bras rangé le long du bord droit, au-dessus de la rangée de commandes
    const aimX = m.width - 22, aimY = py + len;
    const rest = deg(Math.atan2(aimY - py, aimX - px) - Math.atan2(len + 12, -10));
    const rr = rest * Math.PI / 180, hlx = -10, hly = len + 19;
    const restX = px + hlx * Math.cos(rr) - hly * Math.sin(rr);
    const restY = py + hlx * Math.sin(rr) + hly * Math.cos(rr);
    armEl.style.setProperty('--px', px + 'px');
    armEl.style.setProperty('--py', py + 'px');
    armEl.style.setProperty('--play', play + 'deg');
    armEl.style.setProperty('--rest', rest + 'deg');
    taRest.style.setProperty('--rest-x', restX + 'px');
    taRest.style.setProperty('--rest-y', (restY + 9) + 'px');
    const rpmEl = $('rpm');
    if (rpmEl) rpmEl.style.top = Math.round(restY + 9 - rpmEl.offsetHeight / 2) + 'px';
    if (!armEl.classList.contains('ready')) requestAnimationFrame(() => requestAnimationFrame(() => armEl.classList.add('ready')));
    sparkGeom.cx = rx; sparkGeom.cy = ry; sparkGeom.w = m.width; sparkGeom.h = m.height;
    sparkGeom.r0 = L.r - L.cx + 12; sparkGeom.r1 = Math.min(m.width / 2 - 14, 156 * DISC); // reste sur le disque, à l'intérieur de l'anneau de laiton
    sizeSpark();
  }
  if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(placeRecord)).observe(metroEl);
  window.addEventListener('resize', () => {
    if (window.innerWidth !== fitW) { fitW = window.innerWidth; fitTries = 0; fitLocked = false; }   // seule une vraie rotation relance l'ajustement
    placeRecord();
  });
  let recordAnim = null, recordRate = 0, recordTarget = 0, recordRaf = 0;
  function spinRecord(on) {
    recordTarget = on ? 1 : 0;
    if (reduceMotion || !recordDisc.animate) return;
    if (!recordAnim) {
      recordAnim = recordDisc.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: rpmDuration(), iterations: Infinity });
      recordAnim.pause();
    }
    if (on && recordAnim.playState !== 'running') { recordAnim.playbackRate = Math.max(recordRate, 0.01); recordAnim.play(); }
    if (recordRaf) return;
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      // Démarrage en ~0,8 s, arrêt en ~1,6 s
      recordRate += (recordTarget > recordRate ? 1.25 : -0.62) * dt;
      recordRate = clamp(recordRate, 0, 1);
      if ((recordTarget === 1 && recordRate >= 1) || (recordTarget === 0 && recordRate <= 0)) {
        recordRate = recordTarget;
        recordRaf = 0;
        if (recordRate === 0) recordAnim.pause(); else recordAnim.playbackRate = 1;
        return;
      }
      recordAnim.playbackRate = Math.max(recordRate, 0.001);
      recordRaf = requestAnimationFrame(step);
    };
    recordRaf = requestAnimationFrame(step);
  }
  /* 33 / 45 tours : vitesse du disque et ambiance lumineuse (jamais le son ni le tempo) */
  function rpmDuration() { return metro.rpm === 45 ? 4000 : 5400; }
  function setRpm(r, announce) {
    metro.rpm = r === 45 ? 45 : 33;
    metroEl.dataset.rpm = String(metro.rpm);
    document.querySelectorAll('.rpm-opt').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.rpm === metro.rpm)));
    if (recordAnim && recordAnim.effect && recordAnim.effect.updateTiming) recordAnim.effect.updateTiming({ duration: rpmDuration() });
    store.set('rpm', metro.rpm);
    if (announce) toast(metro.rpm === 45 ? '45 tours · ambiance lampe d\u2019ampli' : '33 tours · ambiance couchant', 1600);
  }
  /* Choix du son : un toucher le sélectionne et le fait entendre */
  function setSound(s, preview) {
    metro.sound = SOUNDS.indexOf(s) >= 0 ? s : 'cowbell';
    store.set('soundOrder', 2);
    document.querySelectorAll('.snd').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.snd === metro.sound)));
    store.set('sound', metro.sound);
    if (preview) {
      const c = getCtx();
      unlock().then(() => { if (!metro.running) playMetroNote(c.currentTime + 0.03, true, 2, true); });
    }
  }
  document.querySelector('.sounds').addEventListener('click', (e) => {
    const b = e.target.closest('.snd');
    if (b) setSound(b.dataset.snd, true);
  });
  $('rpm').addEventListener('click', (e) => {
    const b = e.target.closest('.rpm-opt');
    setRpm(b ? +b.dataset.rpm : (metro.rpm === 33 ? 45 : 33), true);
  });
  function updateSpinning() {
    document.body.classList.toggle('spinning', metro.running || (!audio.paused && !audio.ended));
  }

  function renderMetroToggle() {
    spinRecord(metro.running);
    updateSpinning();
    const b = $('mToggle');
    b.classList.toggle('running', metro.running);
    $('metro').classList.toggle('running', metro.running);
    b.setAttribute('aria-pressed', String(metro.running));
    $('mToggleLbl').textContent = metro.running ? 'Arrêter' : 'Démarrer';
    b.setAttribute('aria-label', metro.running ? 'Arrêter le métronome' : 'Démarrer le métronome');
  }

  /* Réglette : la zone 60-200 BPM occupe les deux tiers de la course (on y vise plus juste) */
  const SCALE = [[30, 0], [60, 100], [121, 500], [200, 820], [320, 1000]];   // 121 BPM pile au milieu de la réglette
  function bpmToPos(b) {
    for (let i = 1; i < SCALE.length; i++) if (b <= SCALE[i][0] || i === SCALE.length - 1) {
      const a = SCALE[i - 1], c = SCALE[i];
      return a[1] + (b - a[0]) / (c[0] - a[0]) * (c[1] - a[1]);
    }
  }
  function posToBpm(p) {
    for (let i = 1; i < SCALE.length; i++) if (p <= SCALE[i][1] || i === SCALE.length - 1) {
      const a = SCALE[i - 1], c = SCALE[i];
      return a[0] + (p - a[1]) / (c[1] - a[1]) * (c[0] - a[0]);
    }
  }
  /* Nom du mouvement, en italien, affiché dans la bulle pendant qu'on règle */
  function tempoName(b) { return b < 40 ? 'Grave' : b < 60 ? 'Largo' : b < 76 ? 'Adagio' : b < 108 ? 'Andante' : b < 120 ? 'Moderato' : b < 168 ? 'Allegro' : b < 200 ? 'Presto' : 'Prestissimo'; }
  const REF_BPM = 121, REF_POS = bpmToPos(REF_BPM);          // repère de la réglette : le tempo « de départ »
  let stepFlags = null, paintQ = 0, dragPos = null;
  /* Les chiffres, couleurs et le rapporteur ne sont redessinés qu'une fois par image d'écran :
     la réglette reste fluide même quand le doigt envoie beaucoup de mesures. */
  function schedulePaint() { if (!paintQ) paintQ = requestAnimationFrame(paintSlider); }
  function paintSlider() {
    cancelAnimationFrame(paintQ); paintQ = 0;
    const s = $('mSlider'), pos = dragPos != null ? dragPos : bpmToPos(metro.bpm), atRef = metro.bpm === REF_BPM;
    if (Math.abs(+s.value - pos) > 0.5) s.value = Math.round(pos);
    s.style.setProperty('--hi', 'calc(12px + (100% - 24px) * ' + (pos / 1000).toFixed(4) + ')');
    $('mSliderMark').classList.toggle('lit', atRef);
    if (PR && PR.root.classList.contains('on')) paintProt(pos, atRef);
  }
  function setMetroBpm(v) {
    const prevBpm = metro.bpm;
    metro.bpm = clamp(Math.round(v), 30, 320);
    if (typeof renderMini === 'function') renderMini();
    if (metro.bpm !== prevBpm && typeof peekTempo === 'function') peekTempo();
    const inp = $('mBpm');
    if (document.activeElement !== inp) inp.value = metro.bpm;
    $('mSlider').setAttribute('aria-valuetext', metro.bpm + ' BPM');
    const fl = (metro.bpm <= 30 ? 'a' : '') + (metro.bpm >= 320 ? 'b' : '');
    if (fl !== stepFlags) {
      stepFlags = fl;
      document.querySelectorAll('.mctl .step').forEach((b) => {
        const st = +b.dataset.step;
        b.disabled = (st < 0 && metro.bpm <= 30) || (st > 0 && metro.bpm >= 320);
      });
    }
    schedulePaint();
  }

  /* Affichage tête haute : une plaque vitrée suit le curseur pendant le réglage (tempo en gros, mouvement dessous) */
  let PR = null;
  function buildProt() {
    const root = $('mProt');
    if (!root) return;
    const br = (x, y, dx, dy) => '<path d="M' + (x + dx * 11) + ' ' + y + ' L' + x + ' ' + y + ' L' + x + ' ' + (y + dy * 11) + '"/>';
    let tk = '';
    for (let j = -10; j <= 19; j++) { const m = ((j % 10) + 10) % 10; tk += '<line x1="' + (80 + 5 * j) + '" y1="4" x2="' + (80 + 5 * j) + '" y2="' + (4 + (m === 0 ? 9 : m === 5 ? 6 : 3.5)) + '" stroke-width="' + (m === 0 ? 1.5 : 1) + '"/>'; }
    root.innerHTML = '<svg viewBox="0 0 160 84" aria-hidden="true">'
      + '<defs><filter id="pr-gl" x="-30%" y="-40%" width="160%" height="180%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>'
      + '<linearGradient id="pr-mg"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".25" stop-color="#fff"/><stop offset=".75" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
      + '<mask id="pr-mk" maskUnits="userSpaceOnUse" x="32" y="0" width="96" height="16"><rect x="32" y="0" width="96" height="16" fill="url(#pr-mg)"/></mask></defs>'
      + '<g class="p-brs" fill="none" stroke-width="1.7" stroke-linecap="square">' + br(3, 3, 1, 1) + br(157, 3, -1, 1) + br(3, 81, 1, -1) + br(157, 81, -1, -1) + '</g>'
      + '<g class="p-tapewrap" mask="url(#pr-mk)"><g class="p-tape" stroke-linecap="butt">' + tk + '</g></g>'
      + '<path class="p-dia" d="M80 18.5 L84 22.5 L80 26.5 L76 22.5Z"/>'
      + '<text class="p-u" x="14" y="26" font-size="8.5" font-weight="700" letter-spacing="1.6">BPM</text>'
      + '<g class="p-ret" fill="none" stroke-width="1.2" stroke-linecap="round"><path d="M9 47 H25 M9 44.5 V49.5"/><path d="M151 47 H135 M151 44.5 V49.5"/><path d="M28 47 H31 M129 47 H132" /></g>'
      + '<text class="p-num" x="80" y="58" text-anchor="middle" font-size="33" font-weight="700" filter="url(#pr-gl)" style="font-family:var(--f-num);font-variant-numeric:tabular-nums">121</text>'
      + '<text class="p-name" x="80" y="76" text-anchor="middle" font-size="13" font-weight="700" letter-spacing="2.6" style="font-family:var(--f-ui)"></text>'
      + '<path class="p-car" d="M-6 0 L6 0 L0 7Z" transform="translate(80 85)"/>'
      + '</svg>';
    PR = { root, tape: root.querySelector('.p-tape'), car: root.querySelector('.p-car'), num: root.querySelector('.p-num'), name: root.querySelector('.p-name'), left: 0, W: 300, vw: 400 };
  }
  function protGeo() {
    if (!PR) return;
    const r = $('mSlider').getBoundingClientRect();
    PR.left = r.left; PR.W = r.width; PR.vw = document.documentElement.clientWidth;
  }
  function paintProt(pos, atRef) {
    const k = pos / 1000, w = 156, tx = 12 + (PR.W - 24) * k;
    // la plaque se décale du côté opposé au déplacement, sans jamais sortir de l'écran
    let c = tx - (k - .5) * 2 * 34;
    c = Math.max(w / 2 + 8 - PR.left, Math.min(PR.vw - w / 2 - 8 - PR.left, c));
    PR.root.style.setProperty('--pl', c.toFixed(1) + 'px');
    PR.car.setAttribute('transform', 'translate(' + Math.max(22, Math.min(138, 80 + (tx - c))).toFixed(1) + ' 85)');
    PR.tape.setAttribute('transform', 'translate(' + (-(metro.bpm % 10) * 5) + ' 0)');
    PR.num.textContent = metro.bpm;
    PR.name.textContent = tempoName(metro.bpm).toUpperCase();
    PR.root.classList.toggle('ref', atRef);
  }
  function commitMetroInput() {
    const v = parseInt(String($('mBpm').value).replace(/\D/g, ''), 10);
    if (isFinite(v)) {
      if (v < 30 || v > 320) toast('Le métronome va de 30 à 320 BPM.');
      setMetroBpm(v);
    }
    $('mBpm').value = metro.bpm;
  }

  const SUB_NAMES = { 1: 'noire', 2: 'croche', 3: 'triolet', 4: 'double croche' };
  function setSub(n) {
    if (metro.running) metro.pendingSub = n; else metro.sub = n;
    document.querySelectorAll('.sub').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.sub === n)));
    // Bouton du haut : la figure en cours
    const src = document.querySelector('.subdiv .sub[data-sub="' + n + '"] svg');
    if (src) $('figIc').innerHTML = src.outerHTML;
    $('figBtn').setAttribute('aria-label', 'Figure : ' + SUB_NAMES[n] + '. Touche pour changer.');
  }

  /* Petit menu des figures sous le bouton du haut (copie des 4 boutons du bas, toujours synchronisés) */
  const figBtn = $('figBtn'), figMenu = $('figMenu');
  document.querySelectorAll('.subdiv .sub').forEach((b) => {
    const c = b.cloneNode(true);
    figMenu.appendChild(c);
    c.addEventListener('click', () => { setSub(+c.dataset.sub); setFigMenu(false); });
  });
  function setFigMenu(open) {
    figMenu.hidden = !open;
    figBtn.setAttribute('aria-expanded', String(open));
  }
  figBtn.addEventListener('click', (e) => { e.stopPropagation(); setFigMenu(figMenu.hidden); });
  document.addEventListener('pointerdown', (e) => { if (!figMenu.hidden && !e.target.closest('.fig-wrap')) setFigMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !figMenu.hidden) { setFigMenu(false); figBtn.focus(); } });

  function setVol(v) {
    metro.vol = clamp(Math.round(v), 0, 100);
    const s = $('mVol');
    if (+s.value !== metro.vol) s.value = metro.vol;
    s.style.setProperty('--hi', metro.vol + '%');
    s.style.setProperty('--fill', mixHex(C.volLow, C.light, Math.pow(metro.vol / 100, 0.8)));
    $('volMeter').style.width = metro.vol + '%';
    const ic = $('volIcon');
    ic.classList.remove('v0', 'v1', 'v2', 'v3');
    ic.classList.add(metro.vol === 0 ? 'v0' : metro.vol < 34 ? 'v1' : metro.vol < 67 ? 'v2' : 'v3');
    if (metroGain && ctx) metroGain.gain.setTargetAtTime(volToGain(metro.vol), ctx.currentTime, 0.015);
    store.set('vol', metro.vol);
  }

  /* ---------- Voyants (temps cliquables : normal → accentué → muet) ---------- */
  const beatsBox = $('beats');
  let beats = [];
  const BEAT_HTML = '<span class="beat-mark" aria-hidden="true"><svg viewBox="0 0 14 8"><path d="M1 1l12 3L1 7"/></svg></span><span class="lamp" aria-hidden="true"><i></i></span><span class="beat-n" aria-hidden="true">';
  function buildBeats() {
    const n = metro.n;
    beatsBox.innerHTML = '';
    let i = 0;
    groupsFor(n, metro.d).forEach((g) => {
      const grp = document.createElement('span');
      grp.className = 'beat-group';
      for (let k = 0; k < g; k++, i++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'beat';
        b.dataset.i = String(i);
        b.innerHTML = BEAT_HTML + (i + 1) + '</span>';
        grp.appendChild(b);
      }
      beatsBox.appendChild(grp);
    });
    beatsBox.dataset.size = n <= 4 ? 'l' : n <= 6 ? 'm' : n <= 9 ? 's' : 'xs';
    beats = Array.from(beatsBox.querySelectorAll('.beat'));
    litBeat = -1;
    renderBeats();
  }
  function renderBeats() {
    beats.forEach((b, i) => {
      const st = metro.pattern[i];
      b.dataset.state = st === 2 ? 'accent' : st === 0 ? 'mute' : 'normal';
      b.setAttribute('aria-label', 'Temps ' + (i + 1) + ' : ' + BEAT_NAMES[st] + '. Touche pour changer.');
    });
  }
  beatsBox.addEventListener('click', (e) => {
    const b = e.target.closest('.beat');
    if (!b) return;
    const i = +b.dataset.i;
    const st = metro.pattern[i];
    metro.pattern[i] = st === 1 ? 2 : st === 2 ? 0 : 1;
    renderBeats();
    if (!reduceMotion) { b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash'); }
  });

  /* Mesure à molettes : toucher = cran suivant, glisser vers le haut/bas = défiler */
  function setMeter(n, d) {
    if (n === metro.n && d === metro.d) return;
    metro.n = n; metro.d = d;
    metro.pattern = defaultPattern(n, d);
    if (metro.beat >= n) metro.beat = 0;
    buildBeats();
    renderMeter();
    placeRecord();
  }
  /* Panneau « Mesure » : un bac de pochettes (mesures courantes) + mesure personnalisée */
  const SLEEVES = [[2, 4, '#B58CFF'], [3, 4, '#FF6F91'], [4, 4, '#FF9A3D'], [5, 4, '#FFC15A'], [6, 8, '#56C1FF'], [7, 8, '#FF7A5C'], [9, 8, '#8FA4FF'], [12, 8, '#3FD6B5']];   // en haut à la noire, en bas à la croche, de la plus courte à la plus longue
  const sheet = $('meterSheet'), sleevesBox = $('sleeves');
  SLEEVES.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sleeve';
    b.dataset.n = s[0]; b.dataset.d = s[1];
    b.style.setProperty('--tint', s[2]);
    b.setAttribute('aria-label', 'Mesure ' + s[0] + '/' + s[1]);
    b.innerHTML = '<span class="disc" aria-hidden="true"><span class="vin"></span><span class="shine"></span></span><span class="cover" aria-hidden="true"><span class="frac"><b>' + s[0] + '</b><i></i><b>' + s[1] + '</b></span></span>';
    sleevesBox.appendChild(b);
  });
  function renderMeter() {
    $('meterN').textContent = metro.n;
    $('meterD').textContent = metro.d;
    $('meterBtn').setAttribute('aria-label', 'Mesure ' + metro.n + '/' + metro.d + '. Touche pour changer.');
    $('meterNow').textContent = metro.n + '/' + metro.d;
    $('cusN').textContent = metro.n;
    $('cusD').textContent = metro.d;
    sleevesBox.querySelectorAll('.sleeve').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.n === metro.n && +b.dataset.d === metro.d)));
  }
  let sheetReturn = null;
  function openSheet() {
    sheetReturn = document.activeElement;
    sheet.hidden = false;
    void sheet.offsetWidth;
    sheet.classList.add('open');
    const cur = sleevesBox.querySelector('[aria-pressed="true"]') || sleevesBox.querySelector('.sleeve');
    if (cur) cur.focus({ preventScroll: true });
  }
  function closeSheet() {
    sheet.classList.remove('open');
    setTimeout(() => { if (!sheet.classList.contains('open')) sheet.hidden = true; }, reduceMotion ? 0 : 320);
    if (sheetReturn && sheetReturn.focus) sheetReturn.focus({ preventScroll: true });
  }
  $('meterBtn').addEventListener('click', openSheet);
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) { closeSheet(); return; }
    const sl = e.target.closest('.sleeve');
    if (sl) { setMeter(+sl.dataset.n, +sl.dataset.d); renderMeter(); return; }
    const st = e.target.closest('.st-btn');
    if (!st) return;
    const dir = +st.dataset.dir;
    if (st.dataset.k === 'n') setMeter(clamp(metro.n + dir, 1, 12), metro.d);
    else setMeter(metro.n, DENS[clamp(DENS.indexOf(metro.d) + dir, 0, DENS.length - 1)]);
    renderMeter();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!sheet.hidden) closeSheet();
    if (!carnet.hidden) closeCarnet();
  });

  /* Emblème : le mot miroir se retourne ; la spirale ouvre la page de carnet ;
     quand le métronome joue, le point de lumière remonte la spirale (en écho au disque). */
  const carnet = $('carnet'), sigWord = $('sigWord'), sigPath = $('sigPath'), sigDot = $('sigDot');
  let carnetReturn = null, carnetTimers = [];

  /* Écritures en miroir, retournées lettre par lettre.
     Chaque lettre est posée à sa place lisible ; l'état « miroir » la déplace à sa place symétrique
     (par rapport au centre du mot) et la retourne. Le passage miroir → lisible se fait lettre après lettre. */
  const mirrorWords = [];
  function splitMirrorWords() {
    if (mirrorWords.length) return;
    // Inscriptions SVG de la page de carnet (écrites avec scale(-1 1))
    carnet.querySelectorAll('.carnet-page text[transform]').forEach((t) => {
      const m = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)\s*scale\(-1[ ,]+1\)/.exec(t.getAttribute('transform') || '');
      if (!m) return;
      const X = +m[1], Y = +m[2], str = t.textContent;
      t.removeAttribute('transform');
      t.setAttribute('x', '0'); t.setAttribute('y', String(Y));
      const W = t.getComputedTextLength();
      const x0 = X - W;
      t.setAttribute('x', String(x0));
      const letters = [];
      const parent = t.parentNode;
      for (let i = 0; i < str.length; i++) {
        if (str[i] === ' ') continue;
        const ext = t.getExtentOfChar(i);
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        el.setAttribute('x', String(ext.x)); el.setAttribute('y', String(Y));
        el.textContent = str[i];
        el.style.transformBox = 'fill-box';
        el.style.transformOrigin = 'center';
        parent.appendChild(el);
        letters.push({ el: el, d: 2 * ((x0 + W / 2) - (ext.x + ext.width / 2)) });
      }
      t.remove();
      mirrorWords.push(letters);
    });
    // Le mot « quart de temps » sous le dessin (HTML)
    const span = sigWord.querySelector('span');
    const str = span.textContent;
    span.textContent = '';
    const els = [];
    for (const ch of str) {
      const s = document.createElement('span');
      s.className = 'ltr';
      s.textContent = ch === ' ' ? ' ' : ch;
      span.appendChild(s);
      els.push(s);
    }
    // Mesures de mise en page (insensibles à l'animation d'ouverture de la carte)
    // (le conteneur est positionné : la position de chaque lettre est relative à lui)
    const W = span.offsetWidth;
    mirrorWords.push(els.map((s) => ({ el: s, d: 2 * (W / 2 - (s.offsetLeft + s.offsetWidth / 2)) })));
  }
  function setMirror(letters, mirrored) {
    letters.forEach((l) => { l.el.style.transform = mirrored ? 'translateX(' + l.d + 'px) scaleX(-1)' : 'none'; });
  }
  function revealLetters(letters, delay) {
    letters.forEach((l, i) => {
      const a = l.el.animate([{ transform: 'translateX(' + l.d + 'px) scaleX(-1)' }, { transform: 'translateX(' + (l.d / 2) + 'px) scaleX(0)', offset: .5 }, { transform: 'none' }],
        { duration: 460, delay: delay + i * 55, easing: 'cubic-bezier(.3,.9,.3,1)', fill: 'backwards' });
      a.onfinish = () => { l.el.style.transform = 'none'; };
    });
    return delay + letters.length * 55 + 460;
  }
  // Inverse : les lettres repassent en miroir, de la dernière à la première
  function hideLetters(letters, delay) {
    const n = letters.length;
    letters.forEach((l, i) => {
      const k = n - 1 - i, mir = 'translateX(' + l.d + 'px) scaleX(-1)';
      const a = l.el.animate([{ transform: 'none' }, { transform: 'translateX(' + (l.d / 2) + 'px) scaleX(0)', offset: .5 }, { transform: mir }],
        { duration: 420, delay: delay + k * 45, easing: 'cubic-bezier(.3,.9,.3,1)', fill: 'forwards' });
      a.onfinish = () => { l.el.style.transform = mir; a.cancel(); };
    });
    return delay + n * 45 + 420;
  }
  /* Le carnet respire tant qu'il est ouvert : pause lisible, les lettres repassent en miroir,
     la spirale s'efface du centre vers l'extérieur, page presque vide, puis tout se retrace.
     Le mot et la légende du bas restent fixes après la première ouverture. */
  function carnetCycle(wait) {
    const ink = carnet.querySelector('.carnet-ink'), L = ink.getTotalLength();
    const page = mirrorWords.slice(0, -1);
    const later = (ms, fn) => carnetTimers.push(setTimeout(fn, ms));
    const inkTo = (from, to, dur) => {
      ink.getAnimations().forEach((a) => a.cancel());
      ink.animate([{ strokeDashoffset: from }, { strokeDashoffset: to }], { duration: dur, easing: 'cubic-bezier(.45,.05,.4,1)', fill: 'both' });
    };
    later(wait, () => {
      let t = 0;
      page.slice().reverse().forEach((w) => { t = hideLetters(w, t) - w.length * 25; });
      later(t, () => {
        inkTo(0, -L, 1500);
        later(1500 + 1000, () => {
          inkTo(-L, 0, 2000);
          let t2 = 2050;
          page.forEach((w) => { t2 = revealLetters(w, t2) - w.length * 30; });
          carnetCycle(t2 + 5000);
        });
      });
    });
  }
  sigWord.addEventListener('click', () => {
    // Un toucher rejoue le retournement du mot
    const w = mirrorWords[mirrorWords.length - 1];
    if (!w || reduceMotion) return;
    setMirror(w, true);
    revealLetters(w, 150);
  });
  function openCarnet() {
    carnetReturn = document.activeElement;
    carnet.hidden = false;
    void carnet.offsetWidth;
    carnet.classList.add('open');
    splitMirrorWords();
    carnetTimers.forEach(clearTimeout); carnetTimers = [];
    const ink = carnet.querySelector('.carnet-ink'), cap = carnet.querySelector('.carnet-cap');
    if (ink.getAnimations) {
      ink.getAnimations().forEach((a) => a.cancel());
      mirrorWords.forEach((w) => w.forEach((l) => l.el.getAnimations().forEach((a) => a.cancel())));
    }
    if (reduceMotion || !ink.animate) {
      mirrorWords.forEach((w) => setMirror(w, false));
    } else {
      // 1. La spirale se trace de l'extérieur vers le centre
      const L = ink.getTotalLength();
      ink.style.strokeDasharray = L + ' ' + L;
      ink.animate([{ strokeDashoffset: -L }, { strokeDashoffset: 0 }], { duration: 2000, delay: 250, easing: 'cubic-bezier(.45,.05,.4,1)', fill: 'both' });
      // 2. Puis les écritures se remettent à l'endroit, lettre par lettre
      mirrorWords.forEach((w) => setMirror(w, true));
      let t = 2300;
      mirrorWords.forEach((w) => { t = revealLetters(w, t) - w.length * 30; });
      // 3. La légende apparaît en fondu
      cap.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: t, fill: 'both' });
      // 4. Puis le cycle aller-retour de la page, sans fin tant que le carnet est ouvert
      carnetCycle(t + 700 + 5000);
    }
    const c = carnet.querySelector('.carnet-close');
    if (c) c.focus({ preventScroll: true });
  }
  function closeCarnet() {
    carnet.classList.remove('open');
    carnetTimers.forEach(clearTimeout); carnetTimers = [];
    setTimeout(() => { if (!carnet.classList.contains('open')) carnet.hidden = true; }, reduceMotion ? 0 : 320);
    if (carnetReturn && carnetReturn.focus) carnetReturn.focus({ preventScroll: true });
  }
  $('sigEmblem').addEventListener('click', openCarnet);
  carnet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeCarnet(); });
  const sigLen = sigPath.getTotalLength ? sigPath.getTotalLength() : 0;
  function drawSig() {
    if (!sigLen || !metro.running || !ctx || reduceMotion || !SPARK.bar) return;
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const frac = clamp(sparkProgress(ctx.currentTime - lat) / sparkTurns(), 0, 1);
    const pt = sigPath.getPointAtLength(sigLen * frac);
    sigDot.setAttribute('cx', pt.x.toFixed(1));
    sigDot.setAttribute('cy', pt.y.toFixed(1));
  }

  let litBeat = -1;
  const volMeter = $('volMeter');
  /* Pendule de Newton à deux billes : à chaque clic, les billes se touchent au centre, en bas.
     La bille qui arrive s'arrête net, l'autre repart, revient et frappe pile au clic suivant.
     Mouvement de pendule (ralenti en haut), recalé sur l'horloge audio à chaque temps. */
  const cbL = $('cbL'), cbR = $('cbR'), cbFlash = $('cbFlash'), wmHalo = $('wmHalo');
  const CR = { t: 0, side: 1, started: false, l: 0, r: 0 };
  const CR_AMP = 34;
  function cradleBeat(ev) {
    CR.t = ev.t;
    CR.side = -CR.side;
    CR.started = true;
    if (ev.st === 0 || !cbFlash.animate) return;
    const peak = metro.muted ? 0.35 : (ev.st === 2 ? 1 : 0.8);
    cbFlash.style.fill = ev.beat === 0 ? 'var(--amber)' : 'var(--light)';
    cbFlash.animate([{ opacity: peak, transform: 'scale(1.3)' }, { opacity: 0, transform: 'scale(.6)' }], { duration: 260, easing: 'ease-out' });
  }
  function setCradle(l, r) {
    if (Math.abs(l - CR.l) > 0.05) { cbL.setAttribute('transform', 'rotate(' + l.toFixed(2) + ' 20 6.4)'); CR.l = l; }
    if (Math.abs(r - CR.r) > 0.05) { cbR.setAttribute('transform', 'rotate(' + r.toFixed(2) + ' 28 6.4)'); CR.r = r; }
  }
  function drawCradle() {
    if (metro.running && ctx && CR.started && !reduceMotion) {
      const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      const ph = clamp((ctx.currentTime - lat - CR.t) / (60 / metro.bpm), 0, 1);
      const a = CR_AMP * Math.sin(Math.PI * ph);
      // Bille gauche : rotation positive = vers la gauche ; bille droite : rotation négative = vers la droite
      if (CR.side > 0) setCradle(0, -a); else setCradle(a, 0);
    } else if (CR.l || CR.r) {
      // À l'arrêt : les billes reviennent doucement au contact
      setCradle(Math.abs(CR.l) < 0.3 ? 0 : CR.l * 0.85, Math.abs(CR.r) < 0.3 ? 0 : CR.r * 0.85);
      if (!CR.l && !CR.r) { cbL.removeAttribute('transform'); cbR.removeAttribute('transform'); }
    }
  }
  function setMuted(m) {
    metro.muted = m;
    const b = $('muteBtn');
    b.setAttribute('aria-pressed', String(m));
    b.setAttribute('aria-label', m ? 'Remettre le son du métronome' : 'Couper le son du métronome (l\'animation continue)');
    metroEl.classList.toggle('muted', m);
    if (metroGain && ctx) metroGain.gain.setTargetAtTime(volToGain(metro.vol), ctx.currentTime, 0.02);
  }
  $('muteBtn').addEventListener('click', () => setMuted(!metro.muted));

  function lightBeat(i, st) {
    beats.forEach((d, k) => d.classList.toggle('on', k === i));
    litBeat = i;
    if (i < 0 || reduceMotion || st === 0) return;
    const lamp = beats[i].querySelector('.lamp');
    if (lamp.animate) lamp.animate([{ transform: 'scale(' + (st === 2 ? 1.16 : 1.09) + ')' }, { transform: 'scale(1)' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.3,1)' });
  }
  const metroGlow = $('metroGlow');
  const taLed = $('taLed');
  function volPulse(strength, first) {
    if (!metro.vol || metro.muted || !volMeter.animate) return;
    volMeter.style.background = first ? 'var(--amber)' : 'var(--light)';
    volMeter.animate([{ opacity: 0.85 * strength * (0.35 + 0.65 * metro.vol / 100) }, { opacity: 0 }], { duration: 260, easing: 'ease-out' });
  }
  function metroVisual() {
    if (!metro.running || !ctx) return;
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    const now = ctx.currentTime - lat;
    while (metro.queue.length && metro.queue[0].t <= now) {
      const ev = metro.queue.shift();
      if (ev.isBeat) {
        lightBeat(ev.beat, ev.st);
        sparkBeat(ev, now);
        cradleBeat(ev);
        // La lueur derrière le A de l'en-tête respire doucement à chaque temps
        if (ev.st !== 0 && !reduceMotion && wmHalo.animate) {
          wmHalo.animate([{ opacity: ev.beat === 0 ? 1.6 : 1.3, transform: 'scale(1.12)' }, { opacity: 1, transform: 'scale(1)' }], { duration: Math.min(420, 60000 / metro.bpm * 0.8), easing: 'ease-out' });
        }
        // La LED de la tête de lecture pulse au clic : ambre sur le 1, bleue ailleurs
        if (taLed && ev.st !== 0) {
          taLed.style.fill = ev.beat === 0 ? 'var(--amber)' : 'var(--light)';
          if (!reduceMotion && taLed.animate) taLed.animate([{ opacity: 1 }, { opacity: 0.45 }], { duration: Math.min(500, 60000 / metro.bpm * 0.8), easing: 'ease-out' });
        }
      }
      else if (ev.st !== 0 && litBeat >= 0 && !reduceMotion) {
        const lamp = beats[litBeat].querySelector('.lamp');
        if (lamp.animate) lamp.animate([{ transform: 'scale(1.05)' }, { transform: 'scale(1)' }], { duration: 110, easing: 'ease-out' });
      }
      if (ev.st !== 0) volPulse(ev.isBeat ? (ev.st === 2 ? 1 : 0.7) : 0.4, ev.isBeat && ev.beat === 0);
      // Le pupitre respire en ambre à chaque premier temps
      if (ev.isBeat && ev.beat === 0 && ev.st !== 0 && !reduceMotion && metroGlow.animate) {
        metroGlow.animate([{ opacity: ev.st === 2 ? 1 : 0.75 }, { opacity: 0 }], { duration: Math.min(900, 60000 / metro.bpm * 1.6), easing: 'ease-out' });
      }
    }
  }

  /* ===================================================================== */
  /*                       Boucle d'affichage unique                         */
  /* ===================================================================== */
  let lastCur = -1, lastDur = -1;
  function frame() {
    requestAnimationFrame(frame);
    checkLoop();
    if (!audio.paused || G.mode || VIEW.anim || dirty) {
      const p = displayPos();
      drawWave(p);
      dirty = false;
      const c = Math.floor(p), d = Math.floor(dur());
      if (c !== lastCur) { $('tCur').textContent = fmt(c); lastCur = c; }
      if (d !== lastDur) { $('tDur').textContent = fmt(d); lastDur = d; }
    }
    metroVisual();
    drawSpark();
    drawSig();
    drawCradle();
    drawDust();
  }

  /* ===================================================================== */
  /*                         Écran allumé, système                          */
  /* ===================================================================== */
  let wakeLock = null;
  async function updateWake() {
    const need = (!audio.paused && !audio.ended) || metro.running;
    try {
      if (need && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!need && wakeLock) {
        const w = wakeLock; wakeLock = null; await w.release();
      }
    } catch (e) { wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { updateWake(); dirty = true; } });

  function setMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: P.name, artist: 'Quart de temps' });
      navigator.mediaSession.setActionHandler('play', play);
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('seekto', (d) => { if (d && isFinite(d.seekTime)) audio.currentTime = d.seekTime; });
    } catch (e) { /* non pris en charge */ }
  }

  /* ===================================================================== */
  /*                           Branchements                                  */
  /* ===================================================================== */
  function holdRepeat(btn, fn) {
    let t1 = 0, t2 = 0;
    const stop = () => { clearTimeout(t1); clearInterval(t2); };
    btn.addEventListener('pointerdown', (e) => {
      if (btn.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
      fn();
      stop();
      t1 = setTimeout(() => { t2 = setInterval(() => { if (btn.disabled) stop(); else fn(); }, 85); }, 420);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('click', (e) => { if (e.detail === 0) fn(); }); // clavier
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // Petit rebond au relâchement des boutons : on sent qu'on manipule un objet
  document.addEventListener('pointerup', (e) => {
    if (reduceMotion) return;
    const b = e.target.closest && e.target.closest('button');
    if (!b || b.disabled || b.classList.contains('beat') || !b.animate) return;
    b.animate([{ transform: 'scale(.95)' }, { transform: 'scale(1.035)' }, { transform: 'scale(1)' }], { duration: 280, easing: 'ease-out' });
  });

  const fileInput = $('fileInput');
  const pick = () => { unlock(); fileInput.value = ''; fileInput.click(); };
  $('importBtn').addEventListener('click', pick);
  $('emptyImport').addEventListener('click', pick);
  $('removeBtn').addEventListener('click', removeTrack);
  fileInput.addEventListener('change', () => { if (fileInput.files && fileInput.files[0]) loadFile(fileInput.files[0]); });

  $('btnPlay').addEventListener('click', togglePlay);
  audio.addEventListener('timeupdate', checkLoop); // la boucle A/B tient même écran verrouillé (animations suspendues)
  $('btnA').addEventListener('click', () => setMark('A'));
  $('btnB').addEventListener('click', () => setMark('B'));
  $('btnLoop').addEventListener('click', () => {
    if (P.A == null || P.B == null) { toast('Pose d’abord A et B.'); return; }
    P.loop = !P.loop;
    if (P.loop && !audio.paused && (audio.currentTime < P.A || audio.currentTime >= P.B)) audio.currentTime = P.A;
    renderLoop(); dirty = true;
  });
  $('btnClear').addEventListener('click', () => { P.A = P.B = null; P.loop = false; renderLoop(); dirty = true; });

  $('speed').addEventListener('input', (e) => setSpeed(+e.target.value));
  /* Pastilles de page : A (métronome) et B (ralentisseur) */
  (function pager() {
    const nav = $('pager'); if (!nav) return;
    const dots = nav.querySelectorAll('button');
    let q = 0, cur = 'A', landed = 'A', endT = 0;
    const where = () => $('pageB').getBoundingClientRect().top < window.innerHeight * 0.5 ? 'B' : 'A';
    const upd = () => {
      q = 0;
      const w = where();
      dots[0].classList.toggle('on', w === 'A'); dots[1].classList.toggle('on', w === 'B');
      if (w !== cur) {
        cur = w;
        // Chaque page est un monde à part : en changeant de page, l'autre se tait
        if (w === 'B' && metro.running) stopMetro();
        if (w === 'A' && !audio.paused) audio.pause();
      }
    };
    // Calage : quand la page s'immobilise, elle se pose avec un petit rebond (et une courte vibration sur Android)
    const dock = () => {
      const w = where();
      if (w === landed) return;
      landed = w;
      if (reduceMotion) return;
      const el = w === 'A' ? $('metro') : $('player');
      el.classList.remove('dock'); void el.offsetWidth; el.classList.add('dock');
      setTimeout(() => el.classList.remove('dock'), 700);
      if (!isIOS && navigator.vibrate) { try { navigator.vibrate(16); } catch (err) { /* ignoré */ } }
    };
    window.addEventListener('scroll', () => {
      if (!q) q = requestAnimationFrame(upd);
      clearTimeout(endT); endT = setTimeout(dock, 140);     // arrêt du défilement (repli si « scrollend » n'existe pas)
    }, { passive: true });
    if ('onscrollend' in window) window.addEventListener('scrollend', () => { clearTimeout(endT); dock(); });
    dots.forEach((b) => b.addEventListener('click', () => $(b.dataset.go).scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })));
    upd();
  })();
  holdRepeat($('spMinus'), () => setSpeed(P.speed - 5));
  holdRepeat($('spPlus'), () => setSpeed(P.speed + 5));
  $('spReset').addEventListener('click', () => setSpeed(100));

  /* BPM d'origine : un simple toucher n'ouvre plus le clavier ; double-toucher pour le corriger */
  const ob = $('origBpm');
  ob.readOnly = true;
  let obLastTap = 0;
  function editOrig() {
    if (ob.disabled) return;
    ob.readOnly = false;
    ob.closest('.orig-field').classList.add('editing');
    ob.focus();
    ob.select();
  }
  ob.addEventListener('pointerup', (e) => {
    if (!ob.readOnly || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const now = performance.now();
    if (now - obLastTap < 350) { obLastTap = 0; editOrig(); } else obLastTap = now;
  });
  ob.addEventListener('dblclick', (e) => { e.preventDefault(); if (ob.readOnly) editOrig(); });
  ob.addEventListener('change', commitOrig);
  ob.addEventListener('keydown', (e) => { if (e.key === 'Enter') ob.blur(); });
  ob.addEventListener('blur', () => { commitOrig(); ob.readOnly = true; ob.closest('.orig-field').classList.remove('editing'); });


  document.querySelectorAll('.mctl .step').forEach((b) => holdRepeat(b, () => setMetroBpm(metro.bpm + +b.dataset.step)));
  $('mSlider').addEventListener('input', (e) => setMetroBpm(posToBpm(+e.target.value)));
  /* Glisser sur la réglette : geste rapide = le curseur suit le doigt ; geste lent = réglage fin, de 1 en 1.
     L'affichage tête haute s'ouvre au-dessus pendant le réglage. Un tape sur le repère du milieu revient à 121. */
  buildProt();
  (function sliderTouch() {
    const hit = $('mSliderHit'), inp = $('mSlider');
    if (!hit) return;
    const D = { id: null, x: 0, t: 0, acc: 0, sx: 0, t0: 0, moved: false };
    let wasRef = false, glideId = 0;
    const posAt = (x) => { const r = inp.getBoundingClientRect(); return clamp((x - r.left - 11) / Math.max(1, r.width - 22), 0, 1) * 1000; };
    const fx = () => {
      const r = metro.bpm === REF_BPM;
      if (r && !wasRef && navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* ignoré */ } }
      wasRef = r;
    };
    const place = (p) => { dragPos = p; setMetroBpm(posToBpm(p)); fx(); paintSlider(); };
    // Retour en douceur au tempo de départ (121)
    function glideTo(target) {
      cancelAnimationFrame(glideId);
      const from = metro.bpm, t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 240);
        setMetroBpm(from + (target - from) * (1 - Math.pow(1 - k, 3)));
        fx();
        if (k < 1) glideId = requestAnimationFrame(step);
      };
      glideId = requestAnimationFrame(step);
    }
    hit.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      cancelAnimationFrame(glideId);
      D.id = e.pointerId; D.x = e.clientX; D.t = e.timeStamp; D.acc = 0; D.sx = e.clientX; D.t0 = e.timeStamp; D.moved = false;
      try { hit.setPointerCapture(e.pointerId); } catch (err) { /* ignoré */ }
      wasRef = metro.bpm === REF_BPM; UIF.drag = true;
      protGeo();
      if (PR) PR.root.classList.add('on');
      place(posAt(e.clientX));
      paintSlider();
    });
    hit.addEventListener('pointermove', (e) => {
      if (e.pointerId !== D.id) return;
      if (Math.abs(e.clientX - D.sx) > 8) D.moved = true;
      place(posAt(e.clientX));                              // le curseur suit le doigt, sans frein
    });
    const end = (e) => {
      if (e.pointerId !== D.id) return;
      D.id = null; dragPos = null; UIF.drag = false; schedulePaint();
      if (PR) PR.root.classList.remove('on');
      // simple tape sur le repère du milieu : retour au tempo de départ
      const r = inp.getBoundingClientRect();
      if (e.type === 'pointerup' && !D.moved && e.timeStamp - D.t0 < 450 && Math.abs(e.clientX - (r.left + r.width / 2)) < 22 && metro.bpm !== REF_BPM) glideTo(REF_BPM);
    };
    hit.addEventListener('pointerup', end);
    hit.addEventListener('pointercancel', end);
  })();
  const mb = $('mBpm');
  const tw = $('tempoWin');
  // Glisser sur la fenêtre Tempo règle le BPM (haut/droite = plus vite) ; double-tape ouvre le clavier.
  const TW = { id: null, x0: 0, y0: 0, moved: false, long: false, timer: 0 };
  function startEditBpm() {
    tw.classList.add('editing');
    mb.readOnly = false;
    mb.focus();
    mb.select();
  }
  // Toucher l'étiquette du disque démarre ou arrête le métronome (le réflexe des élèves) ;
  // un appui long ouvre le clavier pour saisir le tempo. Glisser fait défiler la page.
  tw.addEventListener('pointerdown', (e) => {
    if (tw.classList.contains('editing') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    TW.id = e.pointerId; TW.x0 = e.clientX; TW.y0 = e.clientY; TW.moved = false; TW.long = false;
    clearTimeout(TW.timer);
    TW.timer = setTimeout(() => { if (TW.id !== null && !TW.moved) { TW.long = true; startEditBpm(); } }, 550);
  });
  tw.addEventListener('pointermove', (e) => {
    if (e.pointerId !== TW.id) return;
    if (Math.abs(e.clientY - TW.y0) + Math.abs(e.clientX - TW.x0) > 8) { TW.moved = true; clearTimeout(TW.timer); }
  });
  function twEnd(e) {
    if (e.pointerId !== TW.id) return;
    TW.id = null;
    clearTimeout(TW.timer);
    tw.classList.remove('dragging');
    if (TW.moved || TW.long || tw.classList.contains('editing')) return;
    toggleMetro();
  }
  tw.addEventListener('pointerup', twEnd);
  tw.addEventListener('pointercancel', (e) => { if (e.pointerId === TW.id) { TW.id = null; clearTimeout(TW.timer); tw.classList.remove('dragging'); } });
  tw.addEventListener('contextmenu', (e) => e.preventDefault());

  /* TAP tempo : tape au moins deux fois en rythme ; moyenne des derniers écarts, remise à zéro après 2 s de pause */
  const tapBtn = $('tapBtn'), taps = [];
  tapBtn.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
    taps.push(now);
    if (taps.length > 6) taps.shift();
    tapBtn.classList.remove('flash'); void tapBtn.offsetWidth; tapBtn.classList.add('flash');
    setTimeout(() => tapBtn.classList.remove('flash'), 120);
    if (taps.length >= 2) {
      const gaps = taps.slice(1).map((t, i) => t - taps[i]);
      const avg = gaps.reduce((x, y) => x + y, 0) / gaps.length;
      setMetroBpm(60000 / avg);
    }
  });
  tapBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapBtn.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'keyboard' })); } });
  mb.addEventListener('keydown', (e) => {
    if (mb.readOnly && (e.key === 'Enter' || /^\d$/.test(e.key))) {
      if (e.key === 'Enter') e.preventDefault();
      startEditBpm();
      e.stopImmediatePropagation();
    }
  });
  mb.addEventListener('change', commitMetroInput);
  mb.addEventListener('blur', () => { commitMetroInput(); mb.readOnly = true; tw.classList.remove('editing'); });
  mb.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !mb.readOnly) mb.blur(); });
  document.querySelectorAll('.sub').forEach((b) => b.addEventListener('click', () => setSub(+b.dataset.sub)));
  $('mToggle').addEventListener('click', toggleMetro);
  $('mVol').addEventListener('input', (e) => { setVol(+e.target.value); volArm(); });
  /* Volume : le haut-parleur sous TAP déplie une petite réglette, qui se replie seule */
  const volBtn = $('volBtn'), volPop = $('volPop');
  let volT = 0;
  function volArm() { clearTimeout(volT); volT = setTimeout(() => volOpen(false), 2200); }
  function volOpen(o) {
    volPop.hidden = !o;
    volBtn.setAttribute('aria-expanded', String(o));
    clearTimeout(volT);
    if (o) volArm();
  }
  volBtn.addEventListener('click', () => volOpen(volPop.hidden));
  $('mVol').addEventListener('pointerdown', () => clearTimeout(volT));
  $('mVol').addEventListener('pointerup', volArm);
  $('mVol').addEventListener('pointercancel', volArm);
  document.addEventListener('pointerdown', (e) => { if (!volPop.hidden && !e.target.closest('.vol-anchor')) volOpen(false); });

  /* Cadres biseautés : huit facettes taillées comme une pierre, éclairées d'en haut à gauche */
  (function bevels() {
    const NS = 'http://www.w3.org/2000/svg', C = 16, B = 7, K = C + B * (Math.SQRT2 - 1);
    // couleur de chaque facette : haut, haut-droit, droite, bas-droit, bas, bas-gauche, gauche, haut-gauche
    // opacité du blanc de chaque facette : haut, haut-droit, droite, bas-droit, bas, bas-gauche, gauche, haut-gauche
    const FACE = [0.42, 0.2, 0.1, 0.05, 0.04, 0.12, 0.3, 0.58];
    document.querySelectorAll('.deck').forEach((deck, di) => {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'deck-bevel');
      svg.setAttribute('aria-hidden', 'true');
      deck.appendChild(svg);
      const draw = () => {
        const w = deck.offsetWidth, h = deck.offsetHeight;
        if (!w || !h) return;
        svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
        const O = [[C, 0], [w - C, 0], [w, C], [w, h - C], [w - C, h], [C, h], [0, h - C], [0, C]];
        const I = [[K, B], [w - K, B], [w - B, K], [w - B, h - K], [w - K, h - B], [K, h - B], [B, h - K], [B, K]];
        let defs = '', body = '';
        for (let i = 0; i < 8; i++) {
          const j = (i + 1) % 8, id = 'bv' + di + '_' + i;
          const mo = [(O[i][0] + O[j][0]) / 2, (O[i][1] + O[j][1]) / 2], mi = [(I[i][0] + I[j][0]) / 2, (I[i][1] + I[j][1]) / 2];
          // la facette « monte » : plus sombre au bord extérieur, plus claire vers l'arête intérieure
          defs += '<linearGradient id="' + id + '" gradientUnits="userSpaceOnUse" x1="' + mo[0] + '" y1="' + mo[1] + '" x2="' + mi[0] + '" y2="' + mi[1] + '">' +
            '<stop offset="0" stop-color="#EAF4FF" stop-opacity="' + (FACE[i] * 0.45).toFixed(3) + '"/><stop offset=".7" stop-color="#F4FAFF" stop-opacity="' + FACE[i] + '"/><stop offset="1" stop-color="#BFEADB" stop-opacity="' + (FACE[i] * 0.8 + 0.06).toFixed(3) + '"/></linearGradient>';
          body += '<polygon points="' + [O[i], O[j], I[j], I[i]].map((q) => q.join(',')).join(' ') + '" fill="url(#' + id + ')"/>';
        }
        const ring = (P) => P.map((q) => q.join(',')).join(' ');
        body += '<polygon class="bv-outer" points="' + ring(O) + '"/><polygon class="bv-inner" points="' + ring(I) + '"/><polygon class="bv-ridge" points="' + ring(I.map((q) => [q[0] + (q[0] < w / 2 ? 1 : -1), q[1] + (q[1] < h / 2 ? 1 : -1)])) + '"/>';
        svg.innerHTML = '<defs>' + defs + '</defs>' + body;
      };
      draw();
      new ResizeObserver(() => requestAnimationFrame(draw)).observe(deck);
    });
  })();

  // Clavier (ordinateur) : Espace = lecture, M = métronome
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' && e.target.type !== 'range') return;
    if (e.code === 'Space' && tag !== 'BUTTON') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'm' || e.key === 'M') toggleMetro();
  });

  // Glisser-déposer (ordinateur)
  const drop = $('drop');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0) { dragDepth++; drop.classList.add('show'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) drop.classList.remove('show'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; drop.classList.remove('show');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  // Ouverture / partage depuis le système (application installée)
  if ('launchQueue' in window) {
    try {
      window.launchQueue.setConsumer(async (params) => {
        if (params && params.files && params.files.length) loadFile(await params.files[0].getFile());
      });
    } catch (e) { /* ignoré */ }
  }
  async function checkShared() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (e) { return; }
    if (!q.has('shared')) return;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignoré */ }
    try {
      const cache = await caches.open('atelier-share');
      const r = await cache.match('shared-audio');
      if (!r) return;
      const blob = await r.blob();
      const name = decodeURIComponent(r.headers.get('x-filename') || 'Morceau partagé');
      await cache.delete('shared-audio');
      loadFile(new File([blob], name, { type: blob.type || 'audio/mpeg' }));
    } catch (e) { /* ignoré */ }
  }

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    // Mises à jour : le service worker est revérifié à chaque retour sur l'appli ;
    // les fichiers sont servis « réseau d'abord », donc une nouvelle version arrive dès qu'on est en ligne.
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
      }).catch(() => {});
    });
  }

  /* ---------- Démarrage ---------- */
  setSpeed(100);
  setMetroBpm(metro.bpm);
  setSub(metro.sub);
  setVol(metro.vol);
  buildBeats();
  renderMeter();
  setRpm(metro.rpm, false);
  setSound(metro.sound, false);
  // Nettoyage des anciennes mémoires de réglages (ils ne sont plus restaurés)
  ['bpm', 'sub', 'pattern', 'meter', 'beatsTip'].forEach((k) => { try { localStorage.removeItem('atelier.' + k); } catch (e) { /* ignoré */ } });
  $('knobClose').setAttribute('aria-disabled', 'true');
  if (!store.get('started', false)) $('mToggle').classList.add('invite');   // tant qu'on n'a jamais démarré, le Play invite à l'appuyer
  renderSpeedWitness();
  renderTransport();
  renderLoop();
  renderBpm();
  sizeWave();
  requestAnimationFrame(frame);
  checkShared();
})();
