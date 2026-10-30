// Visualizador: abre com zoom a partir do quadrado, desliza entre fotos, zoom com roda/duplo clique,
// arrastar para baixo fecha, tira de miniaturas e painel de informações.

import { api, thumbUrl, fullUrl } from './api.js';
import { h, icon, fmt, nf } from './util.js';
import { S, emit, save, isFav, toggleFav, editV, isDeleted, recover, setHidden, isHidden, placeLabel, resolvePlace, albumItems } from './store.js';
import { menu, toast, alertBox } from './ui.js';
import { tiles } from './map.js';

let V = null;

export function openViewer(list, index, { grid, rect } = {}) {
  if (!list?.length) return;
  closeNow();
  const el = h('div.viewer');
  V = { list, index, grid, el, scale: 1, x: 0, y: 0, chrome: true, info: false, startRect: rect };
  build();
  document.body.append(el);
  show(index, rect ? 'zoom' : 'fade');
  document.addEventListener('keydown', onKey, true);
}

function closeNow() {
  if (!V) return;
  document.removeEventListener('keydown', onKey, true);
  V.el.remove();
  V.map?.remove();
  V = null;
}

export function closeViewer() {
  if (!V) return;
  const v = V;
  const it = v.list[v.index];
  stopVideo();
  let target = null;
  if (v.grid) {
    const gi = v.grid.items.indexOf(it);
    if (gi >= 0) {
      v.grid.scrollToIndex(gi, 'nearest');
      target = v.grid.tileRect(gi);
    }
  }
  const media = v.cur?.querySelector('.media');
  v.el.classList.add('closing');
  if (target && media && v.scale === 1) {
    const r = media.getBoundingClientRect();
    const sx = target.width / r.width, sy = target.height / r.height, s = Math.max(sx, sy);
    const cx = target.left + target.width / 2 - (r.left + r.width / 2);
    const cy = target.top + target.height / 2 - (r.top + r.height / 2);
    media.style.transition = 'transform .42s cubic-bezier(.3,1.1,.4,1), clip-path .42s cubic-bezier(.3,1.1,.4,1), border-radius .42s';
    const insetX = (1 - sx / s) * 50, insetY = (1 - sy / s) * 50;
    media.style.transform = `translate(${cx}px, ${cy}px) scale(${s})`;
    media.style.clipPath = `inset(${insetY}% ${insetX}%)`;
  } else if (media) {
    media.style.transition = 'transform .3s, opacity .3s';
    media.style.transform += ' scale(.9)';
    media.style.opacity = 0;
  }
  setTimeout(() => {
    if (V === v) closeNow();
    emit();
  }, 400);
}

// ---------- montagem ----------
function build() {
  const v = V;
  v.stage = h('div.v-stage');
  v.title = h('div.v-title', h('b'), h('span'));
  v.favBtn = h('button.gbtn.round', { title: 'Favoritar (F)', onclick: () => fav() });
  v.infoBtn = h('button.gbtn.round', { title: 'Informações (I)', onclick: () => toggleInfo() }, icon('info'));
  v.editBtn = h('button.gbtn', { title: 'Editar (E)', onclick: () => edit() }, 'Editar');
  v.strip = h('div.v-strip');
  v.stripWrap = h('div.v-stripwrap.glass', v.strip);
  v.panel = h('aside.v-info.glass');
  const top = h('div.v-top',
    h('div.pill.glass', h('button.gbtn', { onclick: closeViewer, title: 'Voltar (Esc)' }, icon('back'), 'Voltar')),
    v.title,
    h('div.pill.glass', v.editBtn, h('button.gbtn.round', { title: 'Mais', onclick: e => moreMenu(e.currentTarget) }, icon('more'))));
  v.actions = h('div.v-actions');
  const bottom = h('div.v-bottom', v.stripWrap, v.actions);
  v.prev = h('button.v-nav.prev.glass', { onclick: () => step(-1), title: 'Anterior (←)' }, icon('back'));
  v.next = h('button.v-nav.next.glass', { onclick: () => step(1), title: 'Próxima (→)' }, icon('fwd'));
  v.el.append(h('div.v-bg'), v.stage, v.prev, v.next, top, bottom, v.panel);
  bindGestures();
}

function renderActions() {
  const v = V, it = cur();
  if (isDeleted(it)) {
    v.actions.replaceChildren(
      h('div.pill.glass', h('button.gbtn', { onclick: () => { recover([it.id]); afterRemoval(); } }, 'Recuperar')),
      h('div.pill.glass', h('button.gbtn.danger', { onclick: () => deleteNow(it) }, 'Apagar')));
    return;
  }
  v.favBtn.replaceChildren(icon(isFav(it) ? 'heartFill' : 'heart'));
  v.favBtn.classList.toggle('on', isFav(it));
  v.actions.replaceChildren(
    h('div.pill.glass', h('button.gbtn.round', { title: 'Exportar', onclick: () => import('./app.js').then(m => m.exportItems([it.id])) }, icon('share'))),
    h('div.pill.glass', v.favBtn, v.infoBtn, h('button.gbtn.round', { title: 'Editar', onclick: () => edit() }, icon('edit'))),
    h('div.pill.glass', h('button.gbtn.round.danger', { title: 'Apagar (Del)', onclick: () => del() }, icon('trash'))));
}

async function deleteNow(it) {
  const { confirmBox } = await import('./ui.js');
  if (!(await confirmBox('Apagar agora?', 'O arquivo vai para a Lixeira do Windows.', 'Apagar'))) return;
  await api.trash([it.id]);
  const { dropRefs } = await import('./store.js');
  dropRefs(it.id);
  S.all = S.all.filter(i => i !== it);
  S.byId.delete(it.id);
  save();
  afterRemoval();
}

const cur = () => V.list[V.index];

// ---------- exibir uma foto ----------
function slide(it) {
  const s = h('div.v-slide');
  const ev = editV(it);
  let media;
  if (it.video) {
    media = h('video.media', { src: fullUrl(it), poster: thumbUrl(it, 1024), playsInline: true, preload: 'metadata', loop: false });
    media.crossOrigin = 'anonymous';
    s.append(media, videoControls(media));
  } else {
    media = h('div.media');
    const low = h('img.low', { src: thumbUrl(it, 720, ev), draggable: false });
    const hi = h('img.hi', { draggable: false });
    hi.decoding = 'async';
    hi.onload = () => hi.classList.add('ok');
    hi.src = fullUrl(it, ev);
    media.append(low, hi);
    s.append(media);
  }
  fit(s, it);
  return s;
}

/** tamanho de ajuste (o tile "contém" a foto) */
function fit(s, it) {
  const media = s.querySelector('.media');
  const W = innerWidth, H = innerHeight;
  // no vídeo, a barra de reprodução fica abaixo da imagem, não por cima
  const pad = V.chrome ? { t: 70, b: it.video ? 206 : 150 } : { t: 0, b: it.video ? 76 : 0 };
  const aw = W - (V.info ? 380 : 0), ah = H - pad.t - pad.b;
  const ar = it.w && it.h ? it.w / it.h : 1.5;
  let w = aw, hh = aw / ar;
  if (hh > ah) { hh = ah; w = ah * ar; }
  if (!it.video) { w = Math.min(w, Math.max(it.w || w, 200) * 2); hh = w / ar; }
  const base = { w, h: hh, l: (aw - w) / 2, t: pad.t + (ah - hh) / 2 };
  s._base = base;
  Object.assign(media.style, { width: base.w + 'px', height: base.h + 'px', left: base.l + 'px', top: base.t + 'px' });
}

function show(index, anim = 'none', dir = 0) {
  const v = V;
  stopVideo();
  v.index = (index + v.list.length) % v.list.length;
  const it = cur();
  const s = slide(it);
  const old = v.cur;
  v.cur = s;
  v.scale = 1; v.x = 0; v.y = 0;
  v.stage.append(s);
  const media = s.querySelector('.media');

  if (anim === 'zoom' && v.startRect) {
    const r = media.getBoundingClientRect(), t = v.startRect;
    const s2 = Math.max(t.width / r.width, t.height / r.height);
    const cx = t.left + t.width / 2 - (r.left + r.width / 2), cy = t.top + t.height / 2 - (r.top + r.height / 2);
    const ix = (1 - t.width / (r.width * s2)) * 50, iy = (1 - t.height / (r.height * s2)) * 50;
    media.style.transform = `translate(${cx}px, ${cy}px) scale(${s2})`;
    media.style.clipPath = `inset(${iy}% ${ix}%)`;
    v.el.classList.add('opening');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      media.style.transition = 'transform .5s cubic-bezier(.2,1.15,.35,1), clip-path .45s cubic-bezier(.2,1,.35,1)';
      media.style.transform = '';
      media.style.clipPath = 'inset(0% 0%)';
      v.el.classList.remove('opening');
      setTimeout(() => { media.style.transition = ''; media.style.clipPath = ''; }, 520);
    }));
  } else if (anim === 'fade') {
    s.style.opacity = 0;
    requestAnimationFrame(() => { s.style.transition = 'opacity .25s'; s.style.opacity = 1; });
  } else if (anim === 'slide' && old) {
    s.style.transform = `translateX(${dir * 100}%)`;
    requestAnimationFrame(() => {
      s.style.transition = old.style.transition = 'transform .42s cubic-bezier(.22,1,.36,1)';
      s.style.transform = 'translateX(0)';
      old.style.transform = `translateX(${-dir * 100}%)`;
    });
  }
  if (old) setTimeout(() => old.remove(), anim === 'slide' ? 430 : 0);

  // título
  const d = new Date(it.t);
  v.title.firstChild.textContent = fmt.relDay(d);
  const place = placeLabel(it.lat != null ? it : null);
  v.title.lastChild.textContent = [fmt.time(d), place].filter(Boolean).join(' · ');
  if (it.lat != null && !place) resolvePlace(it).then(p => { if (V && cur() === it && p) v.title.lastChild.textContent = `${fmt.time(d)} · ${p}`; if (V?.info) renderInfo(); });
  v.prev.classList.toggle('hidden', v.list.length < 2);
  v.next.classList.toggle('hidden', v.list.length < 2);
  v.editBtn.classList.toggle('hidden', isDeleted(it) || it.video);
  renderActions();
  renderStrip();
  if (v.info) renderInfo();
  preload(v.index + 1);
  preload(v.index - 1);
  if (it.video) setTimeout(() => V?.cur === s && s.querySelector('video')?.play().catch(() => {}), 350);
}

function preload(i) {
  const it = V.list[(i + V.list.length) % V.list.length];
  if (it && !it.video) new Image().src = fullUrl(it, editV(it));
}

function step(d) {
  if (V.list.length < 2) return;
  show(V.index + d, 'slide', d);
}

// ---------- tira de miniaturas ----------
function renderStrip() {
  const v = V;
  const n = v.list.length;
  if (n < 2) return v.stripWrap.classList.add('hidden');
  v.stripWrap.classList.remove('hidden');
  const span = 18;
  const a = Math.max(0, v.index - span), b = Math.min(n - 1, v.index + span);
  const kids = [];
  for (let i = a; i <= b; i++) {
    const it = v.list[i];
    kids.push(h('button.st' + (i === v.index ? '.on' : ''), { onclick: () => i !== v.index && show(i, 'slide', i > v.index ? 1 : -1) },
      h('img', { src: thumbUrl(it, 200, editV(it)), draggable: false })));
  }
  v.strip.replaceChildren(...kids);
  const on = v.strip.querySelector('.on');
  requestAnimationFrame(() => {
    const W = v.stripWrap.clientWidth;
    v.strip.style.transform = `translateX(${W / 2 - (on.offsetLeft + on.offsetWidth / 2)}px)`;
  });
}

// ---------- vídeo ----------
function videoControls(video) {
  const play = h('button.gbtn.round', { onclick: () => (video.paused ? video.play() : video.pause()) }, icon('play'));
  const time = h('span.vt', '0:00');
  const bar = h('input.vbar', { type: 'range', min: 0, max: 1000, value: 0 });
  const mute = h('button.gbtn.round', { onclick: () => { video.muted = !video.muted; mute.replaceChildren(icon(video.muted ? 'mute' : 'speaker')); } }, icon('speaker'));
  const big = h('button.vbig.glass.dim', { onclick: () => video.play() }, icon('play'));
  const ui = h('div.vctl', big, h('div.vbarwrap.glass', play, time, bar, h('span.vt.total', '0:00'), mute));
  video.addEventListener('play', () => { play.replaceChildren(icon('pause')); big.classList.add('hidden'); });
  video.addEventListener('pause', () => { play.replaceChildren(icon('play')); big.classList.remove('hidden'); });
  video.addEventListener('loadedmetadata', () => (ui.querySelector('.total').textContent = fmt.dur(video.duration)));
  video.addEventListener('timeupdate', () => {
    time.textContent = fmt.dur(video.currentTime);
    if (!bar.dragging) bar.value = (video.currentTime / (video.duration || 1)) * 1000;
    bar.style.setProperty('--p', bar.value / 10 + '%');
  });
  video.addEventListener('error', () => {
    big.classList.add('hidden');
    ui.append(h('div.verr.glass', 'Este formato de vídeo não abre aqui.', h('button.gbtn.accent', { onclick: () => api.openDefault(cur().id) }, 'Abrir no Player')));
  });
  bar.addEventListener('input', () => { bar.dragging = true; video.currentTime = (bar.value / 1000) * (video.duration || 0); bar.style.setProperty('--p', bar.value / 10 + '%'); });
  bar.addEventListener('change', () => (bar.dragging = false));
  video.addEventListener('click', e => { e.stopPropagation(); video.paused ? video.play() : video.pause(); });
  return ui;
}
function stopVideo() {
  V?.cur?.querySelector('video')?.pause();
}

// ---------- gestos: zoom, arrastar, deslizar, puxar para fechar ----------
// O zoom muda o tamanho real do elemento (e não um transform: scale): assim o navegador redesenha a
// foto a partir do arquivo original em cada nível, em vez de ampliar a imagem já reduzida (ficava borrado).
function apply(anim) {
  const media = V.cur?.querySelector('.media');
  const b = V.cur?._base;
  if (!media || !b) return;
  const w = b.w * V.scale, hh = b.h * V.scale;
  const ease = 'cubic-bezier(.22,1,.36,1)';
  media.style.transition = anim ? `left .35s ${ease}, top .35s ${ease}, width .35s ${ease}, height .35s ${ease}` : 'none';
  media.style.transform = '';
  Object.assign(media.style, { width: w + 'px', height: hh + 'px', left: b.l + b.w / 2 + V.x - w / 2 + 'px', top: b.t + b.h / 2 + V.y - hh / 2 + 'px' });
  V.el.classList.toggle('zoomed', V.scale > 1.01);
}
function zoomAt(f, cx, cy, anim) {
  const v = V;
  const media = v.cur.querySelector('.media');
  const r = media.getBoundingClientRect();
  const it = cur(), b = v.cur._base;
  const maxScale = Math.max(4, ((it.w || b.w) / b.w) * 8);
  const ns = Math.max(1, Math.min(maxScale, v.scale * f));
  const k = ns / v.scale;
  // mantém o ponto sob o cursor no lugar
  const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
  v.x += (cx - ox) * (1 - k);
  v.y += (cy - oy) * (1 - k);
  v.scale = ns;
  if (ns === 1) { v.x = 0; v.y = 0; }
  clamp();
  apply(anim);
}
function clamp() {
  const v = V, b = v.cur._base;
  const w = b.w * v.scale, hh = b.h * v.scale;
  const mx = Math.max(0, (w - innerWidth) / 2 + 40), my = Math.max(0, (hh - innerHeight) / 2 + 40);
  const bx = Math.max(mx, (w - b.w) / 2), by = Math.max(my, (hh - b.h) / 2);
  v.x = Math.max(-bx, Math.min(bx, v.x));
  v.y = Math.max(-by, Math.min(by, v.y));
}

function bindGestures() {
  const v = V, stage = v.stage;
  let wheelNav = 0, navLock = 0;
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    // roda = foto anterior/próxima (como no Fotos do Windows); Ctrl+roda ou pinça = zoom; com zoom, a roda move a foto
    if (!e.ctrlKey) {
      if (V.scale > 1.01) {
        V.x -= e.deltaX;
        V.y -= e.deltaY;
        clamp();
        apply(false);
        return;
      }
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      wheelNav += d;
      if (Math.abs(wheelNav) > 50 && Date.now() > navLock) { step(wheelNav > 0 ? 1 : -1); wheelNav = 0; navLock = Date.now() + 320; }
      return;
    }
    if (cur().video) return;
    const f = Math.exp(-e.deltaY * 0.01);
    zoomAt(f, e.clientX, e.clientY, false);
  }, { passive: false });

  stage.addEventListener('dblclick', e => {
    if (cur().video) return;
    if (V.scale > 1) { V.scale = 1; V.x = 0; V.y = 0; apply(true); }
    else zoomAt(2.6, e.clientX, e.clientY, true);
  });

  let p = null;
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.vctl')) return;
    p = { x: e.clientX, y: e.clientY, sx: V.x, sy: V.y, t: Date.now(), moved: false, mode: null };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < 5) return;
    p.moved = true;
    const media = V.cur.querySelector('.media');
    if (V.scale > 1.01) {
      V.x = p.sx + dx; V.y = p.sy + dy;
      clamp();
      apply(false);
      return;
    }
    p.mode ||= Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy > 0 ? 'dismiss' : 'none';
    if (p.mode === 'swipe') {
      V.cur.style.transition = 'none';
      V.cur.style.transform = `translateX(${dx}px)`;
    } else if (p.mode === 'dismiss') {
      const k = Math.max(0.55, 1 - dy / 900);
      media.style.transition = 'none';
      media.style.transform = `translate(${dx}px, ${dy}px) scale(${k})`;
      V.el.style.setProperty('--bgop', Math.max(0, 1 - dy / 400));
      V.el.classList.add('dragging');
    }
  });
  const end = e => {
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = Date.now() - p.t;
    const media = V.cur.querySelector('.media');
    if (!p.moved) {
      if (!e.target.closest('video')) toggleChrome();
    } else if (p.mode === 'swipe') {
      const fast = Math.abs(dx) / dt > 0.5;
      if ((Math.abs(dx) > innerWidth * 0.18 || fast) && V.list.length > 1) {
        const d = dx < 0 ? 1 : -1;
        const old = V.cur;
        old.style.transition = 'transform .3s cubic-bezier(.22,1,.36,1)';
        old.style.transform = `translateX(${-d * 100}%)`;
        show(V.index + d, 'slide', d);
      } else {
        V.cur.style.transition = 'transform .35s cubic-bezier(.22,1,.36,1)';
        V.cur.style.transform = '';
      }
    } else if (p.mode === 'dismiss') {
      V.el.classList.remove('dragging');
      if (dy > 120 || dy / dt > 0.6) {
        V.scale = 1; V.x = 0; V.y = 0;
        V.el.style.setProperty('--bgop', 0);
        closeViewer();
      } else {
        V.el.style.setProperty('--bgop', 1);
        media.style.transition = 'transform .4s cubic-bezier(.2,1.2,.35,1)';
        media.style.transform = '';
      }
    }
    p = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  addEventListener('resize', () => V && (fit(V.cur, cur()), (V.scale = 1), (V.x = V.y = 0), apply(false), renderStrip()));
}

function toggleChrome(force) {
  V.chrome = force ?? !V.chrome;
  V.el.classList.toggle('immersive', !V.chrome);
  fit(V.cur, cur());
  V.cur.querySelector('.media').style.transition = 'left .35s cubic-bezier(.22,1,.36,1), top .35s cubic-bezier(.22,1,.36,1), width .35s cubic-bezier(.22,1,.36,1), height .35s cubic-bezier(.22,1,.36,1)';
}

// ---------- ações ----------
function fav() {
  const it = cur();
  toggleFav([it.id]);
  renderActions();
  if (isFav(it)) {
    const b = V.favBtn;
    b.classList.remove('beat');
    void b.offsetWidth;
    b.classList.add('beat');
  }
}

async function del() {
  const it = cur();
  const { deleteItems } = await import('./app.js');
  if (await deleteItems([it.id])) afterRemoval();
}

function afterRemoval() {
  const v = V;
  const it = cur();
  v.list = v.list.filter(x => x !== it);
  if (!v.list.length) return closeViewer();
  show(Math.min(v.index, v.list.length - 1), 'fade');
}

async function edit() {
  const it = cur();
  if (it.video || isDeleted(it)) return;
  stopVideo();
  const { openEditor } = await import('./editor.js');
  openEditor(it, () => {
    if (!V) return;
    const s = slide(it);
    V.cur.replaceWith(s);
    V.cur = s;
    renderStrip();
    renderActions();
  });
}

function moreMenu(anchor) {
  const it = cur();
  const edited = !!editV(it);
  menu([
    { label: 'Copiar', icon: 'copy', run: () => copyImage(it), disabled: it.video },
    { label: 'Adicionar ao Álbum…', icon: 'album', run: () => import('./app.js').then(m => m.pickAlbum([it.id])) },
    { label: 'Apresentação', icon: 'slideshow', run: async () => { const { playMemory } = await import('./memories.js'); playMemory({ title: 'Apresentação', items: V.list.slice(V.index, V.index + 80) }); } },
    '-',
    { label: 'Usar como Papel de Parede', icon: 'wallpaper', run: () => import('./app.js').then(m => m.setWallpaper(it)), disabled: it.video },
    { label: 'Mostrar no Explorador', icon: 'explorer', run: () => api.reveal(it.id) },
    { label: 'Abrir com o App Padrão', icon: 'open', run: () => api.openDefault(it.id) },
    edited && { label: 'Reverter ao Original', icon: 'undo', run: revert },
    '-',
    { label: isHidden(it) ? 'Reexibir' : 'Ocultar', icon: 'hidden', run: () => { setHidden([it.id], !isHidden(it)); toast(isHidden(it) ? 'Ocultado' : 'Reexibido', 'hidden'); if (isHidden(it)) afterRemoval(); } },
    { label: 'Apagar', icon: 'trash', danger: true, run: del },
  ], anchor);
}

async function revert() {
  const it = cur();
  delete S.data.edits[it.id];
  await api.deleteRender(it.id);
  save();
  const s = slide(it);
  V.cur.replaceWith(s);
  V.cur = s;
  renderStrip();
  toast('Revertido ao original', 'undo');
}

async function copyImage(it) {
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = fullUrl(it, editV(it));
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Copiada', 'copy');
  } catch (e) {
    alertBox({ title: 'Não foi possível copiar', message: String(e?.message || e) });
  }
}

// ---------- painel de informações ----------
function toggleInfo(force) {
  V.info = force ?? !V.info;
  V.el.classList.toggle('with-info', V.info);
  V.infoBtn.classList.toggle('on', V.info);
  if (V.info) renderInfo();
  fit(V.cur, cur());
  V.cur.querySelector('.media').style.transition = 'left .45s cubic-bezier(.22,1,.36,1), top .45s, width .45s cubic-bezier(.22,1,.36,1), height .45s cubic-bezier(.22,1,.36,1)';
  V.scale = 1; V.x = V.y = 0; apply(false);
}

function renderInfo() {
  const v = V, it = cur();
  const d = new Date(it.t);
  v.map?.remove();
  v.map = null;
  const cap = h('textarea.cap', { placeholder: 'Adicionar Legenda', rows: 1, value: S.data.captions[it.id] || '' });
  cap.addEventListener('input', () => {
    cap.style.height = 'auto';
    cap.style.height = cap.scrollHeight + 'px';
    if (cap.value.trim()) S.data.captions[it.id] = cap.value; else delete S.data.captions[it.id];
    save();
  });
  cap.addEventListener('keydown', e => e.stopPropagation());
  const mp = it.w && it.h ? Math.round((it.w * it.h) / 1e6) : 0;
  const cam = [it.make && !it.model?.startsWith(it.make) ? it.make : '', it.model].filter(Boolean).join(' ');
  const stats = [
    it.iso ? `ISO ${it.iso}` : null,
    it.focal ? `${(Math.round(it.focal * 100) / 100).toString().replace('.', ',')} mm` : null,
    it.ev != null ? `${it.ev > 0 ? '+' : ''}${(Math.round(it.ev * 10) / 10).toString().replace('.', ',')} ev` : null,
    it.fnum ? `ƒ${it.fnum.toFixed(2).replace(/0$/, '').replace('.', ',')}` : null,
    it.exp ? `${it.exp} s` : null,
  ].filter(Boolean);
  const albums = S.data.albums.filter(a => a.items.includes(it.id));
  const lens = it.lens ? it.lens.replace(it.model || '', '').trim() : '';

  v.panel.replaceChildren(...[
    h('div.i-head', h('div', h('b', fmt.weekday(d)), h('span', `${fmt.day(d)} · ${fmt.time(d)}`)), h('button.gbtn.round', { onclick: () => toggleInfo(false) }, icon('close'))),
    cap,
    h('div.i-card',
      h('div.i-cam', h('b', cam || (it.video ? 'Vídeo' : 'Câmera desconhecida')), h('span.fmtb', it.fmt)),
      h('div.i-body',
        lens ? h('div', lens) : null,
        h('div', [mp ? `${mp} MP` : null, it.w ? `${it.w} × ${it.h}` : null, fmt.bytes(it.size)].filter(Boolean).join(' • ')),
        it.video && it.dur ? h('div', `Duração ${fmt.dur(it.dur)}`) : null),
      stats.length ? h('div.i-stats', stats.map(s => h('span', s))) : null),
    it.lat != null ? h('div.i-map', h('div.i-mapbox')) : null,
    it.lat != null ? h('div.i-place', icon('location'), h('span', placeLabel(it) || `${it.lat.toFixed(4)}, ${it.lon.toFixed(4)}`)) : null,
    albums.length ? h('div.i-sec', h('div.i-t', 'Álbuns'), albums.map(a => h('div.i-album', icon('album'), a.name))) : null,
    h('div.i-sec', h('div.i-t', 'Arquivo'), h('div.i-file', it.name), h('button.i-path', { onclick: () => api.reveal(it.id), title: 'Mostrar no Explorador' }, it.dir)),
  ].filter(Boolean));
  requestAnimationFrame(() => (cap.style.height = cap.scrollHeight + 'px'));
  if (it.lat != null && window.L) {
    const box = v.panel.querySelector('.i-mapbox');
    const m = L.map(box, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false }).setView([it.lat, it.lon], 12);
    tiles().addTo(m);
    L.marker([it.lat, it.lon], { icon: L.divIcon({ className: '', html: `<div class="mk" style="transform:scale(.7)"><div class="ph" style="background-image:url('${thumbUrl(it, 200, editV(it))}')"></div><div class="tail"></div></div>`, iconSize: [58, 58], iconAnchor: [29, 64] }) }).addTo(m);
    box.onclick = () => { closeViewer(); import('./app.js').then(a => a.go({ view: 'map' })); };
    v.map = m;
  }
}

// ---------- teclado ----------
function onKey(e) {
  if (!V || document.querySelector('.editor, .memory, .alert, .sheet, .menu')) return;
  if (e.target.matches?.('textarea, input')) return;
  const k = e.key;
  if (k === 'Escape') { e.preventDefault(); if (V.scale > 1) { V.scale = 1; V.x = V.y = 0; apply(true); } else if (V.info) toggleInfo(false); else closeViewer(); }
  else if (k === 'ArrowRight') step(1);
  else if (k === 'ArrowLeft') step(-1);
  else if (k === 'f' || k === 'F' || k === '.') fav();
  else if (k === 'i' || k === 'I') toggleInfo();
  else if (k === 'e' || k === 'E') edit();
  else if (k === 'Delete') del();
  else if (k === ' ') { e.preventDefault(); const vid = V.cur.querySelector('video'); vid ? (vid.paused ? vid.play() : vid.pause()) : toggleChrome(); }
  else if (k === '+' || k === '=') zoomAt(1.5, innerWidth / 2, innerHeight / 2, true);
  else if (k === '-') zoomAt(1 / 1.5, innerWidth / 2, innerHeight / 2, true);
  else if (k === '0') { V.scale = 1; V.x = V.y = 0; apply(true); }
  else return;
  e.stopPropagation();
}
