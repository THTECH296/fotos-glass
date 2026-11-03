// Memórias: apresentação em tela cheia com efeito Ken Burns, cartão de título e trilha ambiente gerada na hora.

import { thumbUrl } from './api.js';
import { h, icon } from './util.js';
import { S, save, editV } from './store.js';

const DUR = 4600;
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)');

export function playMemory(m) {
  const items = (m.items || []).filter(Boolean);
  if (!items.length) return;
  // um vídeo tocando no visualizador por baixo misturava o som com a trilha
  document.querySelectorAll('video').forEach(v => v.pause());
  const el = h('div.memory');
  const stage = h('div.m-stage');
  const segs = h('div.m-segs', items.length <= 48 ? items.map(() => h('div.seg', h('i'))) : h('div.seg.one', h('i')));
  const title = h('div.m-title', h('b', m.title || ''), h('span', m.subtitle || ''));
  const playBtn = h('button.gbtn.round', { title: 'Pausar (Espaço)', onclick: () => toggle() }, icon('pause'));
  const muteBtn = h('button.gbtn.round', { title: 'Música', onclick: () => toggleMusic() }, icon(S.data.settings.memMusic === false ? 'mute' : 'speaker'));
  const ctl = h('div.m-ctl',
    h('div.pill.glass.dim', h('button.gbtn.round', { title: 'Fechar (Esc)', onclick: close }, icon('close'))),
    h('div', { style: { flex: 1 } }),
    h('div.pill.glass.dim', muteBtn, playBtn));
  el.append(stage, h('div.m-shade'), segs, title, ctl,
    h('button.m-tap.l', { onclick: () => go(i - 1) }), h('button.m-tap.r', { onclick: () => go(i + 1) }));
  document.body.append(el);

  let i = -1, paused = false, closed = false, timer = 0, t0 = 0, elapsed = 0, idle;
  // uma referência só: a música ligada no meio também precisa obedecer ao Pausar
  let music = S.data.settings.memMusic === false ? null : startMusic();

  const preload = k => { const it = items[k]; if (it) new Image().src = thumbUrl(it, 1600, editV(it)); };

  function slide(k) {
    const it = items[k];
    const img = h('img', { src: thumbUrl(it, 1600, editV(it)), draggable: false });
    const s = h('div.m-slide', img);
    // Ken Burns: começa e termina em enquadramentos diferentes
    const r = () => Math.random() * 2 - 1;
    const z0 = 1.08 + Math.random() * 0.08, z1 = 1.18 + Math.random() * 0.1;
    const zoomIn = Math.random() > 0.4;
    const a = `scale(${zoomIn ? z0 : z1}) translate(${r() * 2.5}%, ${r() * 2.5}%)`;
    const b = `scale(${zoomIn ? z1 : z0}) translate(${r() * 2.5}%, ${r() * 2.5}%)`;
    // com "Reduzir Movimento", como no iOS: sem zoom/pan, só a dissolução entre as fotos
    // (a regra global do CSS não alcança a Web Animations API)
    if (!REDUCE.matches) img.animate([{ transform: a }, { transform: b }], { duration: DUR + 1400, easing: 'linear', fill: 'forwards' });
    return s;
  }

  function go(k) {
    if (closed) return;
    if (k < 0) k = 0;
    if (k >= items.length) return close();
    i = k;
    const s = slide(i);
    stage.append(s);
    s.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 1000, easing: 'ease', fill: 'forwards' });
    const old = [...stage.children].slice(0, -1);
    setTimeout(() => old.forEach(o => o.remove()), 1100);
    preload(i + 1);
    preload(i + 2);
    if (i === 0) title.classList.add('show');
    else title.classList.remove('show');
    segs.querySelectorAll('.seg').forEach((sg, n) => {
      const bar = sg.firstChild;
      if (sg.classList.contains('one')) return;
      bar.style.transition = 'none';
      bar.style.width = n < i ? '100%' : '0%';
    });
    elapsed = 0;
    run();
  }

  function run() {
    clearTimeout(timer);
    if (paused || closed) return;
    t0 = performance.now();
    const left = DUR - elapsed;
    timer = setTimeout(() => go(i + 1), left);
    const segsAll = segs.querySelectorAll('.seg');
    if (segs.querySelector('.one')) {
      const bar = segs.querySelector('i');
      bar.style.transition = `width ${left}ms linear`;
      bar.style.width = ((i + 1) / items.length) * 100 + '%';
    } else {
      const bar = segsAll[i].firstChild;
      bar.style.transition = 'none';
      bar.style.width = (elapsed / DUR) * 100 + '%';
      requestAnimationFrame(() => { bar.style.transition = `width ${left}ms linear`; bar.style.width = '100%'; });
    }
    stage.getAnimations({ subtree: true }).forEach(a => a.play());
  }

  function toggle() {
    if (closed) return;
    paused = !paused;
    playBtn.replaceChildren(icon(paused ? 'play' : 'pause'));
    el.classList.toggle('paused', paused);
    if (paused) {
      clearTimeout(timer);
      elapsed += performance.now() - t0;
      stage.getAnimations({ subtree: true }).forEach(a => a.pause());
      const bar = segs.querySelector('.one i') || segs.querySelectorAll('.seg')[i]?.firstChild;
      if (bar) { const w = getComputedStyle(bar).width; bar.style.transition = 'none'; bar.style.width = w; }
      music?.pause();
    } else {
      run();
      music?.resume();
    }
  }

  function toggleMusic() {
    const on = S.data.settings.memMusic === false;
    S.data.settings.memMusic = on;
    save();
    muteBtn.replaceChildren(icon(on ? 'speaker' : 'mute'));
    if (on) {
      music ||= startMusic();
      if (paused) music?.pause(); else music?.resume();
    } else {
      music?.stop();
      music = null;
    }
  }

  // fechar duas vezes (ou durante o fade) chamava stop() de novo e dava erro no AudioContext
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(idle);
    music?.stop();
    music = null;
    document.removeEventListener('keydown', key, true);
    el.classList.add('out');
    setTimeout(() => el.remove(), 450);
  }
  const key = e => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else if (e.key === ' ') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowLeft') go(i - 1);
  };
  document.addEventListener('keydown', key, true);
  el.addEventListener('pointermove', () => {
    el.classList.add('ui');
    clearTimeout(idle);
    idle = setTimeout(() => el.classList.remove('ui'), 2200);
  });
  preload(0);
  setTimeout(() => go(0), 60);
}

/** trilha ambiente suave (acordes com ataque lento), feita com WebAudio */
function startMusic() {
  try {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 2.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.38;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    delay.connect(fb).connect(delay);
    lp.connect(master);
    lp.connect(delay).connect(master);
    master.connect(ctx.destination);
    // C – Am – F – G (e uma oitava de brilho)
    const chords = [[60, 64, 67, 72], [57, 60, 64, 69], [53, 57, 60, 65], [55, 59, 62, 67]];
    const hz = n => 440 * 2 ** ((n - 69) / 12);
    let k = 0, stopped = false;
    const bar = 3.2;
    const play = t => {
      const ch = chords[k++ % chords.length];
      ch.forEach((n, j) => {
        const o = ctx.createOscillator();
        o.type = j === 0 ? 'triangle' : 'sine';
        o.frequency.value = hz(n - (j === 0 ? 12 : 0));
        o.detune.value = (Math.random() - 0.5) * 8;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(j === 0 ? 0.22 : 0.12, t + 1.1);
        g.gain.linearRampToValueAtTime(0, t + bar + 1.2);
        o.connect(g).connect(lp);
        o.start(t);
        o.stop(t + bar + 1.4);
      });
      // notinha de piano
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz(ch[1 + Math.floor(Math.random() * 3)] + 12);
      const g = ctx.createGain();
      const tt = t + bar * (0.4 + Math.random() * 0.4);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(0.1, tt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0008, tt + 2.2);
      o.connect(g).connect(lp);
      o.start(tt);
      o.stop(tt + 2.3);
    };
    let next = ctx.currentTime + 0.1;
    const tick = () => {
      if (stopped) return;
      while (next < ctx.currentTime + 1.5) { play(next); next += bar; }
      setTimeout(tick, 400);
    };
    tick();
    // o contexto pode já estar fechado (música desligada) ou ainda suspenso: nada de promessa rejeitada solta
    return {
      pause: () => { if (ctx.state === 'running') ctx.suspend().catch(() => {}); },
      resume: () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); },
      stop: () => {
        if (stopped) return;
        stopped = true;
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(master.gain.value, ctx.currentTime);
        master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
        setTimeout(() => { if (ctx.state !== 'closed') ctx.close().catch(() => {}); }, 700);
      },
    };
  } catch {
    return null;
  }
}
