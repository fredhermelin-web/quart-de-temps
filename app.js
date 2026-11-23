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
  const SAMPLE_FILES = { clave: 'Sound/Clave.mp3', conga: 'Sound/Conga.mp3', cowbell: 'Sound/Cowbell.mp3' };
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
  function loadSamples(c) {
    Object.keys(SAMPLE_FILES).forEach((k) => {
      // D'abord la copie intégrée (sounds.js) : marche aussi en ouverture locale (file://) et hors ligne
      const embedded = window.SOUND_DATA && window.SOUND_DATA[k];
      const source = embedded
        ? Promise.resolve().then(() => b64ToBuffer(embedded))
        : fetch(SAMPLE_FILES[k]).then((r) => { if (!r.ok) throw new Error(k); return r.arrayBuffer(); });
      source
        .then((buf) => new Promise((res, rej) => { const p = c.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); }))
        .then((ab) => { samples[k] = normalize(ab); })
        .catch(() => { /* le clic d'origine sera utilisé */ });
    });
  }
  /* Joue une note du métronome à l'instant t : le 1 plus fort et un peu plus aigu,
     les accents marqués, les subdivisions plus douces */
  function playMetroNote(t, isBeat, st, first) {
    const smp = metro.sound !== 'clic' && samples[metro.sound];
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
  const audio = new Audio();
  audio.preload = 'auto';
  audio.preservesPitch = true;
  audio.mozPreservesPitch = true;
  audio.webkitPreservesPitch = true;

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
      if (P.bpm == null) toast('BPM non détecté : saisis-le dans « BPM d’origine ».', 3800);
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
  $('installClose').addEventListener('click', hidePill);
  installSheet.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeInstallSheet(); });
  if (!isStandalone() && !store.get('installed', false)) {
    $('installLink').hidden = false;
    pill.hidden = false;
    setTimeout(() => pill.classList.add('show'), 60);
    pillTimer = setTimeout(hidePill, 60000);
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
  const SOUNDS = ['clic', 'clave', 'cowbell', 'conga'];
  const metro = {
    bpm: 121,
    sub: 1,
    vol: clamp(+store.get('vol', 80), 0, 100),
    n: 4,
    d: 4,
    rpm: +store.get('rpm', 33) === 45 ? 45 : 33,
    sound: SOUNDS.indexOf(store.get('sound', 'clic')) >= 0 ? store.get('sound', 'clic') : 'clic',
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
  const SPARK = { lastT: 0, k: -1, bar: 0, parts: [], burst: 0, drawn: false, last: 0 };
  // Palettes de lumière : 33 tours (couchant et bleu nuit) / 45 tours (néon cyan et magenta)
  const PAL = {
    33: { tail: [255, 95, 140], mid: [255, 180, 90], head: [140, 215, 255], first: [255, 175, 70], beat: [120, 205, 255], alt: [255, 130, 160] },
    45: { tail: [150, 90, 255], mid: [255, 79, 216], head: [90, 245, 255], first: [255, 79, 216], beat: [61, 242, 255], alt: [170, 120, 255] }
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
    const p = sparkPos(sparkProgress(now)), P = pal();
    const first = ev.beat === 0, accent = ev.st === 2;
    const n = first ? 24 : accent ? 10 : 6;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (first ? 72 : 34) * (0.35 + Math.random());
      SPARK.parts.push({
        x: p[0], y: p[1], vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1,
        decay: first ? 1.3 : 2.2, size: first ? 2.6 : 1.7,
        col: first ? P.first : (Math.random() < 0.3 ? P.alt : P.beat)
      });
    }
    if (first) SPARK.burst = 1;
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
      const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      const u = sparkProgress(ctx.currentTime - lat), P = pal(), T = sparkTurns();
      const fade = Math.min(1, (u + 0.3) / 0.8) * Math.min(1, Math.max(0, T - u) / 1.5);
      // La traînée reste dans le sillon : un arc de spirale qui s'allonge avec le tempo
      const trail = 0.35 + 0.45 * (metro.bpm - 30) / 210;
      const steps = 90;
      c.lineCap = 'round';
      let prev = null;
      for (let i = steps; i >= 0; i--) {
        const uu = u - trail * i / steps;
        if (uu < 0) { prev = null; continue; }
        const p = sparkPos(uu), k = 1 - i / steps;
        if (prev) {
          const grow = 0.8 + 0.6 * (p[2] - g.r0) / Math.max(1, g.r1 - g.r0);
          const col = k < 0.5 ? lerp3(P.tail, P.mid, k * 2) : lerp3(P.mid, P.head, (k - 0.5) * 2);
          c.strokeStyle = rgbaS(col, 0.75 * k * k * fade);
          c.lineWidth = (0.6 + 2.8 * k) * grow;
          c.beginPath();
          c.moveTo(prev[0], prev[1]);
          c.lineTo(p[0], p[1]);
          c.stroke();
        }
        prev = p;
      }
      // Tête : halo, qui prend la couleur du 1 juste après le premier temps
      const p = sparkPos(u), grow = 0.85 + 0.7 * (p[2] - g.r0) / Math.max(1, g.r1 - g.r0);
      const hc = lerp3(P.head, P.first, SPARK.burst);
      const rad = (12 + 10 * SPARK.burst) * grow;
      const gr = c.createRadialGradient(p[0], p[1], 0, p[0], p[1], rad);
      gr.addColorStop(0, 'rgba(255,255,255,' + (0.95 * fade).toFixed(3) + ')');
      gr.addColorStop(0.25, rgbaS(hc, 0.75 * fade));
      gr.addColorStop(1, rgbaS(hc, 0));
      c.fillStyle = gr;
      c.beginPath();
      c.arc(p[0], p[1], rad, 0, Math.PI * 2);
      c.fill();
      // Onde qui s'élargit sur le 1
      if (SPARK.burst > 0) {
        c.strokeStyle = rgbaS(P.first, 0.7 * SPARK.burst * fade);
        c.lineWidth = 2;
        c.beginPath();
        c.arc(p[0], p[1], 6 + (1 - SPARK.burst) * 46, 0, Math.PI * 2);
        c.stroke();
        SPARK.burst = Math.max(0, SPARK.burst - dt * 2.4);
      }
    }
    // Particules
    for (let i = SPARK.parts.length - 1; i >= 0; i--) {
      const q = SPARK.parts[i];
      q.life -= dt * q.decay;
      if (q.life <= 0) { SPARK.parts.splice(i, 1); continue; }
      q.vx *= 0.96; q.vy *= 0.96;
      q.x += q.vx * dt; q.y += q.vy * dt;
      c.fillStyle = 'rgba(' + q.col[0] + ',' + q.col[1] + ',' + q.col[2] + ',' + (q.life * 0.9).toFixed(3) + ')';
      c.beginPath();
      c.arc(q.x, q.y, q.size * (0.5 + q.life * 0.6), 0, Math.PI * 2);
      c.fill();
    }
    if (SPARK.parts.length > 260) SPARK.parts.splice(0, SPARK.parts.length - 260);
    c.globalCompositeOperation = 'source-over';
  }

  /* Le vinyle : centré sur l'étiquette Tempo, il démarre et s'arrête comme une platine */
  const recordEl = $('record'), recordDisc = $('recordDisc'), metroEl = $('metro'), tempoWinEl = $('tempoWin');
  function placeRecord() {
    const m = metroEl.getBoundingClientRect(), t = tempoWinEl.getBoundingClientRect();
    if (!m.width) return;
    const rx = t.left + t.width / 2 - m.left, ry = t.top + t.height / 2 - m.top;
    recordEl.style.setProperty('--rx', rx + 'px');
    recordEl.style.setProperty('--ry', ry + 'px');
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
    // Pivot au-dessus de la colonne +1/+5 ; s'il touche les voyants, il descend juste sous leur rangée
    let px = P1.cx + 4, py = R.t + 30;
    if (R.r > px - 22) { px = m.width - 26; py = R.b + 24; }
    // Tête : dans l'espace entre +1 et +5, côté étiquette
    const hx = (L.r + P1.l) / 2 - 4, hy = (P1.b + P5.t) / 2;
    // Bras raccourci d'environ 10 % : le pivot descend d'autant, la tête reste au même endroit
    py += Math.hypot(hx - px, hy - py) * 0.1;
    const tx = hx - px, ty = hy - py;
    // La tête est à (-10, len + 12) du pivot dans le dessin du bras
    const len = Math.max(60, Math.sqrt(Math.max(0, tx * tx + ty * ty - 100)) - 12);
    taPath.setAttribute('d', 'M0 -17V' + (len - 6) + 'Q0 ' + (len + 4) + ' -7 ' + (len + 11));
    taHead.setAttribute('transform', 'translate(-10 ' + (len + 17) + ') rotate(30)');
    taSvg.setAttribute('viewBox', '-22 -38 44 ' + (len + 70));
    taSvg.setAttribute('height', String(len + 70));
    const play = deg(Math.atan2(ty, tx) - Math.atan2(len + 12, -10));
    // Repos : bras rangé le long du bord droit ; le repose-bras est placé exactement sous la tête
    const aimX = (P1.r + m.width) / 2 - 1, aimY = py + len;
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
    if (!armEl.classList.contains('ready')) requestAnimationFrame(() => requestAnimationFrame(() => armEl.classList.add('ready')));
    sparkGeom.cx = rx; sparkGeom.cy = ry; sparkGeom.w = m.width; sparkGeom.h = m.height;
    sparkGeom.r0 = L.r - L.cx + 12; sparkGeom.r1 = Math.min(m.width * 0.62, 230);
    sizeSpark();
  }
  if (window.ResizeObserver) new ResizeObserver(placeRecord).observe(metroEl);
  window.addEventListener('resize', placeRecord);
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
    if (announce) toast(metro.rpm === 45 ? '45 tours · ambiance néon' : '33 tours · ambiance couchant', 1600);
  }
  /* Choix du son : un toucher le sélectionne et le fait entendre */
  function setSound(s, preview) {
    metro.sound = SOUNDS.indexOf(s) >= 0 ? s : 'clic';
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
  }

  function setMetroBpm(v) {
    metro.bpm = clamp(Math.round(v), 30, 240);
    const inp = $('mBpm');
    if (document.activeElement !== inp) inp.value = metro.bpm;
    const s = $('mSlider');
    if (+s.value !== metro.bpm) s.value = metro.bpm;
    s.style.setProperty('--hi', ((metro.bpm - 30) / 210 * 100) + '%');
    document.querySelectorAll('.mctl .step').forEach((b) => {
      const st = +b.dataset.step;
      b.disabled = (st < 0 && metro.bpm <= 30) || (st > 0 && metro.bpm >= 240);
    });
  }
  function commitMetroInput() {
    const v = parseInt(String($('mBpm').value).replace(/\D/g, ''), 10);
    if (isFinite(v)) {
      if (v < 30 || v > 240) toast('Le métronome va de 30 à 240 BPM.');
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
  const SLEEVES = [[4, 4, '#FF9A3D'], [3, 4, '#FF6F91'], [2, 4, '#B58CFF'], [6, 8, '#56C1FF'], [12, 8, '#3FD6B5'], [5, 4, '#FFC15A'], [7, 8, '#FF7A5C'], [9, 8, '#8FA4FF']];
  const sheet = $('meterSheet'), sleevesBox = $('sleeves');
  SLEEVES.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sleeve';
    b.dataset.n = s[0]; b.dataset.d = s[1];
    b.style.setProperty('--tint', s[2]);
    b.setAttribute('aria-label', 'Mesure ' + s[0] + '/' + s[1]);
    b.innerHTML = '<span class="disc" aria-hidden="true"></span><span class="cover" aria-hidden="true"><span class="frac"><b>' + s[0] + '</b><i></i><b>' + s[1] + '</b></span></span>';
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
  holdRepeat($('spMinus'), () => setSpeed(P.speed - 5));
  holdRepeat($('spPlus'), () => setSpeed(P.speed + 5));
  $('spReset').addEventListener('click', () => setSpeed(100));

  const ob = $('origBpm');
  ob.addEventListener('change', commitOrig);
  ob.addEventListener('keydown', (e) => { if (e.key === 'Enter') ob.blur(); });
  ob.addEventListener('blur', commitOrig);
  ob.addEventListener('focus', () => ob.select());


  document.querySelectorAll('.mctl .step').forEach((b) => holdRepeat(b, () => setMetroBpm(metro.bpm + +b.dataset.step)));
  $('mSlider').addEventListener('input', (e) => setMetroBpm(+e.target.value));
  const mb = $('mBpm');
  const tw = $('tempoWin');
  // Glisser sur la fenêtre Tempo règle le BPM (haut/droite = plus vite) ; double-tape ouvre le clavier.
  const TW = { id: null, x0: 0, y0: 0, bpm0: 0, moved: false, lastTap: 0 };
  function startEditBpm() {
    tw.classList.add('editing');
    mb.readOnly = false;
    mb.focus();
    mb.select();
  }
  // La fenêtre Tempo ne change plus le BPM au glissement (le doigt fait défiler la page).
  // Seul un double-tap ouvre le clavier ; le tempo se règle avec ±1 / ±5 et la réglette.
  tw.addEventListener('pointerdown', (e) => {
    if (tw.classList.contains('editing') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    TW.id = e.pointerId; TW.x0 = e.clientX; TW.y0 = e.clientY; TW.moved = false;
  });
  tw.addEventListener('pointermove', (e) => {
    if (e.pointerId !== TW.id) return;
    if (Math.abs(e.clientY - TW.y0) + Math.abs(e.clientX - TW.x0) > 8) TW.moved = true;
  });
  function twEnd(e) {
    if (e.pointerId !== TW.id) return;
    TW.id = null;
    tw.classList.remove('dragging');
    if (TW.moved) { TW.lastTap = 0; return; }
    const now = performance.now();
    if (now - TW.lastTap < 350) { TW.lastTap = 0; startEditBpm(); }
    else TW.lastTap = now;
  }
  tw.addEventListener('pointerup', twEnd);
  tw.addEventListener('pointercancel', (e) => { if (e.pointerId === TW.id) { TW.id = null; tw.classList.remove('dragging'); } });
  tw.addEventListener('dblclick', (e) => { e.preventDefault(); if (!tw.classList.contains('editing')) startEditBpm(); });
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
  $('mVol').addEventListener('input', (e) => setVol(+e.target.value));

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
  ['bpm', 'sub', 'pattern', 'meter'].forEach((k) => { try { localStorage.removeItem('atelier.' + k); } catch (e) { /* ignoré */ } });
  $('knobClose').setAttribute('aria-disabled', 'true');
  renderSpeedWitness();
  renderTransport();
  renderLoop();
  renderBpm();
  sizeWave();
  requestAnimationFrame(frame);
  checkShared();
})();
