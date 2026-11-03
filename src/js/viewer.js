// Visualizador: abre com zoom a partir do quadrado, desliza entre fotos, zoom com roda/duplo clique,
// arrastar para baixo fecha, tira de miniaturas e painel de informações.

import { api, thumbUrl, fullUrl } from './api.js';
import { h, icon, fmt, nf } from './util.js';
import { S, emit, save, isFav, toggleFav, editV, isDeleted, recover, setHidden, isHidden, placeLabel, resolvePlace, albumItems, dropRefs } from './store.js';
import { menu, closeMenu, toast, alertBox, confirmBox } from './ui.js';
import { tiles } from './map.js';

let V = null;
let lastFocus = null;
let resizeRaf = 0;

// abaixo desta largura o painel de informações vira folha por cima da foto (igual ao viewer.css)
const sheetMode = () => innerWidth < 760;
/** espaço que o painel de Informações ocupa à direita: --info-w do viewer.css + as margens */
const infoSpace = () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--info-w')) || 360) + 20;
// foto aberta pelo Explorador fora das pastas da biblioteca: favoritar/ocultar/álbum não teriam onde aparecer
const isExternal = it => !!it.external || !S.byId.has(it.id);
const playV = vid => vid?.play().catch(() => {});
const togglePlay = vid => vid && (vid.paused ? playV(vid) : vid.pause());

export function openViewer(list, index, { grid, rect } = {}) {
  if (!list?.length) return;
  closeNow();
  lastFocus = document.activeElement;
  const el = h('div.viewer', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Visualizador', tabindex: '-1' });
  V = {
    list, index, grid, el, scale: 1, x: 0, y: 0, chrome: true, info: false, startRect: rect,
    // aberto dentro de Ocultos: Reexibir também tira a foto da lista
    inHidden: list.every(isHidden),
  };
  build();
  document.body.append(el);
  show(index, rect ? 'zoom' : 'fade');
  document.addEventListener('keydown', onKey, true);
  // registrado aqui e removido em closeNow: antes acumulava um por abertura e prendia o viewer velho na memória
  addEventListener('resize', onResize);
  el.focus({ preventScroll: true });
}

function closeNow() {
  if (!V) return;
  const v = V;
  document.removeEventListener('keydown', onKey, true);
  removeEventListener('resize', onResize);
  cancelAnimationFrame(resizeRaf);
  clearTimeout(v.tapT);
  clearTimeout(v.preT);
  v.stage.querySelectorAll('.v-slide').forEach(discard);
  v.el.remove();
  v.map?.remove();
  V = null;
  if (lastFocus?.isConnected && document.activeElement === document.body) lastFocus.focus({ preventScroll: true });
  lastFocus = null;
}

function onResize() {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    if (!V || V.closing) return;
    fit(V.cur, cur());
    V.scale = 1; V.x = V.y = 0;
    apply(false);
    renderStrip();
  });
}

export function closeViewer() {
  if (!V || V.closing) return;
  const v = V;
  v.closing = true;
  // teclado sai na hora: setas durante a animação trocavam a foto que volta ao quadrado
  document.removeEventListener('keydown', onKey, true);
  clearTimeout(v.tapT);
  closeMenu();
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
  v.favBtn = h('button.gbtn.round', { title: 'Favoritar (F)', 'aria-label': 'Favoritar', onclick: () => fav() });
  v.infoBtn = h('button.gbtn.round', { title: 'Informações (I)', 'aria-label': 'Informações', 'aria-pressed': 'false', onclick: () => toggleInfo() }, icon('info'));
  v.editBtn = h('button.gbtn', { title: 'Editar (E)', onclick: () => edit() }, 'Editar');
  v.strip = h('div.v-strip');
  v.stripWrap = h('div.v-stripwrap.glass', v.strip);
  v.panel = h('aside.v-info.glass', { 'aria-label': 'Informações' });
  const top = h('div.v-top',
    h('div.pill.glass', h('button.gbtn', { onclick: closeViewer, title: 'Voltar (Esc)' }, icon('back'), 'Voltar')),
    v.title,
    h('div.pill.glass', v.editBtn, h('button.gbtn.round', { title: 'Mais', 'aria-label': 'Mais opções', 'aria-haspopup': 'menu', onclick: e => moreMenu(e.currentTarget) }, icon('more'))));
  v.actions = h('div.v-actions');
  const bottom = h('div.v-bottom', v.stripWrap, v.actions);
  v.prev = h('button.v-nav.prev.glass', { onclick: () => step(-1), title: 'Anterior (←)', 'aria-label': 'Foto anterior' }, icon('back'));
  v.next = h('button.v-nav.next.glass', { onclick: () => step(1), title: 'Próxima (→)', 'aria-label': 'Próxima foto' }, icon('fwd'));
  v.el.append(h('div.v-bg'), v.stage, v.prev, v.next, top, bottom, v.panel);
  bindGestures();
}

function renderActions() {
  const v = V, it = cur();
  if (isDeleted(it)) {
    v.actions.replaceChildren(
      h('div.pill.glass', h('button.gbtn', { onclick: () => recoverItem(it) }, 'Recuperar')),
      h('div.pill.glass', h('button.gbtn.danger', { onclick: () => deleteNow(it) }, 'Apagar')));
    return;
  }
  const ext = isExternal(it);
  const on = !ext && isFav(it);
  v.favBtn.replaceChildren(icon(on ? 'heartFill' : 'heart'));
  v.favBtn.classList.toggle('on', on);
  v.favBtn.disabled = ext;
  v.favBtn.title = ext ? 'Fora da biblioteca: não dá para favoritar' : on ? 'Desfavoritar (F)' : 'Favoritar (F)';
  v.favBtn.setAttribute('aria-label', on ? 'Desfavoritar' : 'Favoritar');
  v.favBtn.setAttribute('aria-pressed', String(on));
  v.actions.replaceChildren(
    h('div.pill.glass', h('button.gbtn.round', { title: 'Exportar', 'aria-label': 'Exportar', onclick: () => import('./app.js').then(m => m.exportItems([it.id])) }, icon('share'))),
    h('div.pill.glass', v.favBtn, v.infoBtn, h('button.gbtn.round', { title: 'Editar', 'aria-label': 'Editar', onclick: () => edit() }, icon('edit'))),
    h('div.pill.glass', h('button.gbtn.round.danger', { title: 'Apagar (Del)', 'aria-label': 'Apagar', onclick: () => del() }, icon('trash'))));
}

function recoverItem(it) {
  const v = V;
  recover([it.id]);
  afterRemoval(it, v);
}

// apaga de vez (item de Apagados Recentemente ou de fora da biblioteca): vai para a Lixeira do Windows
async function deleteNow(it) {
  const v = V;
  const ext = isExternal(it);
  const ok = await confirmBox(
    ext ? 'Apagar este arquivo?' : 'Apagar agora?',
    ext ? 'Ele não faz parte da biblioteca e vai direto para a Lixeira do Windows.' : 'O arquivo vai para a Lixeira do Windows.',
    'Apagar');
  if (!ok) return;
  try {
    const n = await api.trash([it.id]);
    if (n === 0) throw new Error('Arquivo não encontrado.');
  } catch (e) {
    alertBox({ title: 'Não foi possível apagar', message: String(e?.message || e) });
    return;
  }
  dropRefs(it.id);
  S.all = S.all.filter(i => i.id !== it.id);
  S.byId.delete(it.id);
  save(true);
  toast('Movido para a Lixeira do Windows', 'trash');
  afterRemoval(it, v);
}

const cur = () => V.list[V.index];

// ---------- exibir uma foto ----------
function slide(it, delayHi = 0) {
  const s = h('div.v-slide');
  const ev = editV(it);
  let media;
  if (it.video) {
    media = h('video.media', { src: fullUrl(it, ev), poster: thumbUrl(it, 1024, ev), playsInline: true, preload: 'metadata', loop: false });
    media.crossOrigin = 'anonymous';
    s.append(media, videoControls(media));
  } else {
    media = h('div.media');
    const low = h('img.low', { src: thumbUrl(it, 720, ev), draggable: false, alt: '' });
    const hi = h('img.hi', { draggable: false, alt: it.name || '' });
    hi.decoding = 'async';
    hi.onload = () => hi.classList.add('ok');
    // sem a foto cheia fica a miniatura de 720 px; o zoom é limitado para não ampliar o borrão
    hi.onerror = () => { if (!s._gone) s._hiFail = true; };
    const load = () => { if (!s._gone) hi.src = fullUrl(it, ev); };
    // passando rápido pelas fotos, só baixa a foto cheia de quem parou na tela
    if (delayHi) s._hiT = setTimeout(load, delayHi); else load();
    media.append(low, hi);
    s.append(media);
  }
  fit(s, it);
  return s;
}

/** tira o slide de vez: cancela a foto cheia ainda baixando e solta o vídeo */
function discard(s) {
  clearTimeout(s._hiT);
  s._gone = true;
  const hi = s.querySelector('img.hi');
  if (hi && !hi.complete) hi.removeAttribute('src');
  const vid = s.querySelector('video');
  if (vid) { vid.pause(); vid.removeAttribute('src'); vid.load(); }
  s.remove();
}

/** tamanho de ajuste (o tile "contém" a foto) */
function fit(s, it) {
  const media = s.querySelector('.media');
  const W = innerWidth, H = innerHeight;
  // no vídeo, a barra de reprodução fica abaixo da imagem, não por cima
  const pad = V.chrome ? { t: 70, b: it.video ? 206 : 150 } : { t: 0, b: it.video ? 76 : 0 };
  // em janela estreita o painel fica por cima (folha), então não desconta a largura dele
  const aw = Math.max(0, W - (V.info && !sheetMode() ? infoSpace() : 0)), ah = Math.max(0, H - pad.t - pad.b);
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
  clearTimeout(v.tapT);
  v.tapT = 0;
  v.index = (index + v.list.length) % v.list.length;
  const it = cur();
  const s = slide(it, anim === 'slide' ? 150 : 0);
  const old = v.cur;
  // segurando a seta, só o slide que está saindo continua; os outros saem na hora (antes ficavam 26 vivos)
  v.stage.querySelectorAll('.v-slide').forEach(o => o !== old && discard(o));
  v.cur = s;
  v.scale = 1; v.x = 0; v.y = 0;
  v.el.classList.remove('zoomed');
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
  if (old) setTimeout(() => old.isConnected && v.cur !== old && discard(old), anim === 'slide' ? 430 : 0);

  // título
  const d = new Date(it.t);
  v.title.firstChild.textContent = fmt.relDay(d);
  const place = placeLabel(it.lat != null ? it : null);
  v.title.lastChild.textContent = [fmt.time(d), place].filter(Boolean).join(' · ');
  // só troca os textos: refazer o painel aqui tirava o foco da legenda no meio da digitação
  if (it.lat != null && !place) resolvePlace(it).then(p => {
    if (!p || V !== v || cur() !== it) return;
    v.title.lastChild.textContent = `${fmt.time(d)} · ${p}`;
    if (v.info && v.panel.dataset.id === it.id) {
      const pl = v.panel.querySelector('.i-place span');
      if (pl) pl.textContent = p;
    }
  });
  const many = v.list.length > 1;
  v.prev.classList.toggle('hidden', !many || v.index === 0);
  v.next.classList.toggle('hidden', !many || v.index === v.list.length - 1);
  v.editBtn.classList.toggle('hidden', isDeleted(it));
  renderActions();
  renderStrip();
  if (v.info) renderInfo();
  // vizinhas só depois de parar um pouco, para não baixar todas as fotos puladas
  clearTimeout(v.preT);
  v.preT = setTimeout(() => { if (V === v && cur() === it) { preload(v.index + 1); preload(v.index - 1); } }, 300);
  if (it.video) setTimeout(() => V?.cur === s && playV(s.querySelector('video')), 350);
}

function preload(i) {
  const it = V.list[i];
  if (it && !it.video) new Image().src = fullUrl(it, editV(it));
}

function step(d) {
  const v = V;
  if (v.list.length < 2) return;
  const i = v.index + d;
  // nas pontas não dá a volta para o outro lado: só um empurrão elástico, como no Fotos do iPhone
  if (i < 0 || i >= v.list.length) return bounce(d);
  show(i, 'slide', d);
}

function bounce(d) {
  V.cur?.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-d * 36}px)` }, { transform: 'translateX(0)' }], { duration: 380, easing: 'cubic-bezier(.22,1,.36,1)' });
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
    kids.push(h('button.st' + (i === v.index ? '.on' : ''), {
      'aria-label': `${it.video ? 'Vídeo' : 'Foto'} ${i + 1} de ${n}`,
      'aria-current': i === v.index ? 'true' : null,
      onclick: () => i !== v.index && show(i, 'slide', i > v.index ? 1 : -1),
    }, h('img', { src: thumbUrl(it, 200, editV(it)), draggable: false, alt: '' })));
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
  const play = h('button.gbtn.round', { 'aria-label': 'Reproduzir', onclick: () => togglePlay(video) }, icon('play'));
  const time = h('span.vt', '0:00');
  const bar = h('input.vbar', { type: 'range', min: 0, max: 1000, value: 0, 'aria-label': 'Posição do vídeo' });
  const mute = h('button.gbtn.round', { 'aria-label': 'Sem som', onclick: () => {
    video.muted = !video.muted;
    mute.replaceChildren(icon(video.muted ? 'mute' : 'speaker'));
    mute.setAttribute('aria-label', video.muted ? 'Com som' : 'Sem som');
  } }, icon('speaker'));
  const big = h('button.vbig.glass.dim', { 'aria-label': 'Reproduzir', onclick: () => playV(video) }, icon('play'));
  const ui = h('div.vctl', big, h('div.vbarwrap.glass', play, time, bar, h('span.vt.total', '0:00'), mute));
  video.addEventListener('play', () => { play.replaceChildren(icon('pause')); play.setAttribute('aria-label', 'Pausar'); big.classList.add('hidden'); });
  video.addEventListener('pause', () => { play.replaceChildren(icon('play')); play.setAttribute('aria-label', 'Reproduzir'); big.classList.remove('hidden'); });
  video.addEventListener('loadedmetadata', () => (ui.querySelector('.total').textContent = fmt.dur(video.duration)));
  video.addEventListener('timeupdate', () => {
    time.textContent = fmt.dur(video.currentTime);
    if (!bar.dragging) bar.value = (video.currentTime / (video.duration || 1)) * 1000;
    bar.style.setProperty('--p', bar.value / 10 + '%');
  });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src') || ui.querySelector('.verr')) return;
    big.classList.add('hidden');
    ui.append(h('div.verr.glass', 'Este formato de vídeo não abre aqui.', h('button.gbtn.accent', { onclick: () => api.openDefault(cur().id) }, 'Abrir com o App Padrão')));
  });
  bar.addEventListener('input', () => { bar.dragging = true; video.currentTime = (bar.value / 1000) * (video.duration || 0); bar.style.setProperty('--p', bar.value / 10 + '%'); });
  bar.addEventListener('change', () => (bar.dragging = false));
  // o clique no vídeo é tratado no pointerup do palco (a captura do ponteiro desviava o click do <video>)
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
function resetZoom(anim) {
  V.scale = 1; V.x = V.y = 0;
  apply(anim);
}
function zoomAt(f, cx, cy, anim) {
  const v = V;
  const media = v.cur.querySelector('.media');
  const r = media.getBoundingClientRect();
  const it = cur(), b = v.cur._base;
  // até 3× a resolução real (antes 8×: um panorama passava de 40.000 px de largura)
  const maxScale = v.cur._hiFail ? 2 : Math.max(4, ((it.w || b.w) / b.w) * 3);
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
  // roda: um gesto = uma foto. A inércia do trackpad manda eventos por ~1 s; o gesto só termina
  // depois de 180 ms sem eventos. A roda do mouse (passos de 100) navega a cada passo, com trava de 320 ms.
  let wheelNav = 0, navLock = 0, wheelIdle = 0, used = false, smooth = false;
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
      const notch = e.deltaMode !== 0 || (Math.abs(d) >= 100 && Number.isInteger(d));
      if (!notch) smooth = true;
      clearTimeout(wheelIdle);
      wheelIdle = setTimeout(() => { wheelNav = 0; used = false; smooth = false; }, 180);
      if (Date.now() < navLock || (used && smooth)) { wheelNav = 0; return; }
      wheelNav += d;
      if (Math.abs(wheelNav) > 50) { step(wheelNav > 0 ? 1 : -1); wheelNav = 0; navLock = Date.now() + 320; used = true; }
      return;
    }
    if (cur().video) return;
    const f = Math.exp(-e.deltaY * 0.01);
    zoomAt(f, e.clientX, e.clientY, false);
  }, { passive: false });

  stage.addEventListener('dblclick', e => {
    if (cur().video) return;
    if (V.scale > 1) resetZoom(true);
    else zoomAt(2.6, e.clientX, e.clientY, true);
  });

  // botão direito na foto abre o mesmo menu "…" (antes vinha o menu do WebView2)
  stage.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!e.target.closest('.vctl')) moreMenu({ x: e.clientX, y: e.clientY });
  });

  let p = null;
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.vctl')) return;
    // guardado antes da captura: com ela, o pointerup chega com alvo no palco e não no <video>
    p = { x: e.clientX, y: e.clientY, sx: V.x, sy: V.y, t: Date.now(), moved: false, mode: null, onVideo: !!e.target.closest('video') };
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
    p.mode ||= Math.abs(dx) > Math.abs(dy) ? 'swipe' : dy > 0 ? 'dismiss' : 'up';
    if (p.mode === 'swipe') {
      // resistência nas pontas: não há foto do outro lado
      const edge = (dx > 0 && V.index === 0) || (dx < 0 && V.index === V.list.length - 1);
      V.cur.style.transition = 'none';
      V.cur.style.transform = `translateX(${edge ? dx / 3 : dx}px)`;
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
    const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = Math.max(1, Date.now() - p.t);
    const media = V.cur.querySelector('.media');
    if (!p.moved) {
      if (e.type === 'pointercancel') { /* toque cancelado pelo sistema: não é clique */ }
      else if (p.onVideo) togglePlay(V.cur.querySelector('video'));
      // toque simples espera um pouco: se vier o segundo toque, é duplo clique (zoom) e a interface não pisca
      else if (V.tapT) { clearTimeout(V.tapT); V.tapT = 0; }
      else V.tapT = setTimeout(() => { if (V && !V.closing) { V.tapT = 0; toggleChrome(); } }, 260);
    } else if (p.mode === 'swipe') {
      const fast = Math.abs(dx) / dt > 0.5;
      const d = dx < 0 ? 1 : -1;
      const target = V.index + d;
      if ((Math.abs(dx) > innerWidth * 0.18 || fast) && target >= 0 && target < V.list.length) {
        const old = V.cur;
        old.style.transition = 'transform .3s cubic-bezier(.22,1,.36,1)';
        old.style.transform = `translateX(${-d * 100}%)`;
        show(target, 'slide', d);
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
    } else if (p.mode === 'up') {
      // deslizar para cima abre as informações, como no iPhone
      if ((dy < -60 || dy / dt < -0.5) && !V.info) toggleInfo(true);
    }
    p = null;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

function toggleChrome(force) {
  V.chrome = force ?? !V.chrome;
  V.el.classList.toggle('immersive', !V.chrome);
  // recalcula a base e mantém o zoom atual (como no iPhone); antes a tela voltava ao ajuste e o estado ficava com zoom
  fit(V.cur, cur());
  clamp();
  apply(true);
}

// ---------- ações ----------
function fav() {
  const it = cur();
  if (isDeleted(it)) return;
  if (isExternal(it)) return toast('Fora da biblioteca: não dá para favoritar', 'heart');
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
  const v = V, it = cur();
  // já apagado ou de fora da biblioteca: vai direto para a Lixeira (antes "apagava de novo" e zerava os 30 dias)
  if (isDeleted(it) || isExternal(it)) return deleteNow(it);
  const { deleteItems } = await import('./app.js');
  if (await deleteItems([it.id])) afterRemoval(it, v);
}

/** tira o item da lista do visualizador; `v` evita mexer num visualizador aberto depois (ex.: pelo Explorador) */
function afterRemoval(it, v = V) {
  if (!v || V !== v || v.closing) return;
  const i = v.list.indexOf(it);
  if (i < 0) return;
  v.list = v.list.filter(x => x !== it);
  if (!v.list.length) return closeViewer();
  if (i < v.index) v.index--;
  show(Math.min(v.index, v.list.length - 1), 'fade');
}

async function edit() {
  const v = V, it = cur();
  if (isDeleted(it)) return;
  stopVideo();
  const { openEditor } = await import('./editor.js');
  openEditor(it, () => {
    if (V === v && !v.closing && cur() === it) replaceSlide(it);
  });
}

/** troca o slide atual (depois de editar ou reverter) e zera o que dependia do anterior */
function replaceSlide(it) {
  const v = V, old = v.cur;
  const s = slide(it);
  old.replaceWith(s);
  discard(old);
  v.cur = s;
  v.scale = 1; v.x = v.y = 0;
  v.el.classList.remove('zoomed');
  renderActions();
  renderStrip();
  if (v.info) renderInfo();
  if (it.video) playV(s.querySelector('video'));
}

function moreMenu(anchor) {
  const it = cur();
  let items;
  if (isDeleted(it)) {
    // item de Apagados Recentemente: só faz sentido recuperar ou apagar de vez
    items = [
      { label: 'Recuperar', icon: 'restore', run: () => recoverItem(it) },
      { label: 'Mostrar no Explorador', icon: 'explorer', run: () => api.reveal(it.id) },
      '-',
      { label: 'Apagar Agora', icon: 'trash', danger: true, run: () => deleteNow(it) },
    ];
  } else {
    const ext = isExternal(it);
    const edited = !!editV(it);
    items = [
      { label: 'Copiar', icon: 'copy', kbd: 'Ctrl+C', run: () => copyImage(it), disabled: it.video },
      !ext && { label: 'Adicionar ao Álbum…', icon: 'album', run: () => import('./app.js').then(m => m.pickAlbum([it.id])) },
      { label: 'Apresentação', icon: 'slideshow', run: async () => {
        const v = V;
        stopVideo();
        const { playMemory } = await import('./memories.js');
        if (V === v) playMemory({ title: 'Apresentação', items: v.list.slice(v.index, v.index + 80) });
      } },
      '-',
      { label: 'Usar como Papel de Parede', icon: 'wallpaper', run: () => import('./app.js').then(m => m.setWallpaper(it)), disabled: it.video },
      { label: 'Mostrar no Explorador', icon: 'explorer', run: () => api.reveal(it.id) },
      { label: 'Abrir com o App Padrão', icon: 'open', run: () => api.openDefault(it.id) },
      edited && { label: 'Reverter ao Original', icon: 'undo', run: revert },
      '-',
      !ext && { label: isHidden(it) ? 'Reexibir' : 'Ocultar', icon: 'hidden', run: () => {
        const v = V, hide = !isHidden(it);
        setHidden([it.id], hide);
        toast(hide ? 'Ocultado' : 'Reexibido', 'hidden');
        // ao ocultar, ou ao reexibir dentro de Ocultos, a foto deixa de pertencer à lista aberta
        if (hide || v.inHidden) afterRemoval(it, v);
      } },
      { label: ext ? 'Apagar (vai para a Lixeira)' : 'Apagar', icon: 'trash', danger: true, run: del },
    ];
  }
  menu(items, anchor);
  // foco no primeiro item: as setas e o Enter do menu partem dele
  document.querySelector('.menu .mi:not([disabled])')?.focus({ preventScroll: true });
}

async function revert() {
  const v = V, it = cur();
  delete S.data.edits[it.id];
  await api.deleteRender(it.id);
  save();
  if (V === v && !v.closing && cur() === it) replaceSlide(it);
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
  } catch {
    // a mensagem do navegador vinha crua e em inglês
    alertBox({ title: 'Não foi possível copiar', message: 'A foto não pôde ser lida ou a área de transferência está ocupada. Tente de novo ou use Exportar.' });
  }
}

// ---------- painel de informações ----------
function toggleInfo(force) {
  V.info = force ?? !V.info;
  V.el.classList.toggle('with-info', V.info);
  V.infoBtn.classList.toggle('on', V.info);
  V.infoBtn.setAttribute('aria-pressed', String(V.info));
  if (V.info) renderInfo();
  else if (V.panel.contains(document.activeElement)) V.el.focus({ preventScroll: true });
  // zera o zoom e anima junto com o painel (o apply(false) de antes cortava a transição)
  V.scale = 1; V.x = V.y = 0;
  fit(V.cur, cur());
  apply(true);
}

function renderInfo() {
  const v = V, it = cur();
  const d = new Date(it.t);
  v.map?.remove();
  v.map = null;
  // a legenda em edição é a mesma caixa: recriá-la tirava o foco e as letras viravam atalhos
  const prev = v.panel.querySelector('textarea.cap');
  const keep = prev && document.activeElement === prev && v.panel.dataset.id === it.id;
  const sel = keep ? [prev.selectionStart, prev.selectionEnd] : null;
  const cap = keep ? prev : h('textarea.cap', { placeholder: 'Adicionar Legenda', rows: 1, value: S.data.captions[it.id] || '', 'aria-label': 'Legenda' });
  if (!keep) {
    cap.addEventListener('input', () => {
      cap.style.height = 'auto';
      cap.style.height = cap.scrollHeight + 'px';
      if (cap.value.trim()) S.data.captions[it.id] = cap.value; else delete S.data.captions[it.id];
      save();
    });
    cap.addEventListener('keydown', e => e.stopPropagation());
  }
  v.panel.dataset.id = it.id;
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
  const lens = it.lens ? lensPt(it.lens.replace(it.model || '', '').trim()) : '';

  v.panel.replaceChildren(...[
    h('div.i-head', h('div', h('b', fmt.weekday(d)), h('span', `${fmt.day(d)} · ${fmt.time(d)}`)), h('button.gbtn.round', { title: 'Fechar informações (I)', 'aria-label': 'Fechar informações', onclick: () => toggleInfo(false) }, icon('close'))),
    cap,
    h('div.i-card',
      h('div.i-cam', h('b', cam || (it.video ? 'Vídeo' : 'Câmera desconhecida')), h('span.fmtb', it.fmt)),
      h('div.i-body',
        lens ? h('div', lens) : null,
        h('div', [mp ? `${mp} MP` : null, it.w ? `${it.w} × ${it.h}` : null, fmt.bytes(it.size)].filter(Boolean).join(' • ')),
        it.video && it.dur ? h('div', `Duração ${fmt.dur(it.dur)}`) : null),
      stats.length ? h('div.i-stats', stats.map(s => h('span', s))) : null),
    it.lat != null ? h('div.i-map', h('div.i-mapbox', { role: 'button', 'aria-label': 'Abrir no mapa' })) : null,
    it.lat != null ? h('div.i-place', icon('location'), h('span', placeLabel(it) || `${it.lat.toFixed(4)}, ${it.lon.toFixed(4)}`)) : null,
    albums.length ? h('div.i-sec', h('div.i-t', 'Álbuns'), albums.map(a => h('div.i-album', icon('album'), a.name))) : null,
    h('div.i-sec', h('div.i-t', 'Arquivo'), h('div.i-file', it.name), h('button.i-path', { onclick: () => api.reveal(it.id), title: 'Mostrar no Explorador' }, it.dir)),
  ].filter(Boolean));
  if (keep) {
    // tirar a caixa do DOM tira o foco; devolve com o cursor no mesmo lugar
    cap.focus({ preventScroll: true });
    cap.setSelectionRange(sel[0], sel[1]);
  }
  requestAnimationFrame(() => (cap.style.height = cap.scrollHeight + 'px'));
  if (it.lat != null && window.L) {
    const box = v.panel.querySelector('.i-mapbox');
    const m = L.map(box, { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, keyboard: false }).setView([it.lat, it.lon], 12);
    tiles().addTo(m);
    L.marker([it.lat, it.lon], { icon: L.divIcon({ className: '', html: `<div class="mk" style="transform:scale(.7)"><div class="ph" style="background-image:url('${thumbUrl(it, 200, editV(it))}')"></div><div class="tail"></div></div>`, iconSize: [58, 58], iconAnchor: [29, 64] }) }).addTo(m);
    box.onclick = () => { closeViewer(); import('./app.js').then(a => a.go({ view: 'map' })); };
    v.map = m;
  }
}

/** lente do iPhone em português: "back triple camera 6.765mm f/1.78" → "Câmera tripla traseira — 6,765 mm ƒ1,78".
 *  Só mexe no padrão da Apple (back/front … camera); nomes de lentes de outras câmeras ficam como vieram. */
function lensPt(s) {
  const m = /^(back|front)\s+(.*?)\s*camera\b\s*(.*)$/i.exec(s);
  if (!m) return s;
  const TIPO = { 'triple': 'tripla', 'dual': 'dupla', 'dual wide': 'dupla grande-angular', 'wide': 'grande-angular', 'ultra wide': 'ultra-angular', 'telephoto': 'teleobjetiva', 'truedepth': 'TrueDepth' };
  const tipo = m[2].toLowerCase();
  const nome = ['Câmera', tipo ? (TIPO[tipo] ?? m[2]) : '', m[1].toLowerCase() === 'back' ? 'traseira' : 'frontal'].filter(Boolean).join(' ');
  const resto = m[3]
    .replace(/(\d+(?:\.\d+)?)\s*mm\b/gi, (_, n) => `${n.replace('.', ',')} mm`)
    .replace(/\bf\/(\d+(?:\.\d+)?)/gi, (_, n) => `ƒ${n.replace('.', ',')}`)
    .trim();
  return resto ? `${nome} — ${resto}` : nome;
}

// ---------- teclado ----------
function onKey(e) {
  if (!V || V.closing) return;
  // com o menu "…" aberto, quem trata Esc/setas/Enter é o próprio menu (ui.js)
  if (document.querySelector('.editor, .memory, .alert, .sheet, .menu')) return;
  const k = e.key, t = e.target;
  if (t.matches?.('textarea, input, select, [contenteditable], [contenteditable] *')) {
    // Esc na legenda só sai do campo
    if (k === 'Escape' && V.panel.contains(t)) { e.preventDefault(); e.stopPropagation(); t.blur(); V.el.focus({ preventScroll: true }); }
    return;
  }
  // com Ctrl/Alt/Meta só valem zoom e copiar; o resto (Ctrl+F, Alt+←…) segue para o app/sistema
  if (e.altKey) return;
  if (e.ctrlKey || e.metaKey) {
    if (k === '+' || k === '=') zoomAt(1.5, innerWidth / 2, innerHeight / 2, true);
    else if (k === '-') zoomAt(1 / 1.5, innerWidth / 2, innerHeight / 2, true);
    else if (k === '0') resetZoom(true);
    else if ((k === 'c' || k === 'C') && !cur().video && !isDeleted(cur()) && !String(getSelection())) copyImage(cur());
    else return;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (k === 'Escape') { e.preventDefault(); if (V.scale > 1) resetZoom(true); else if (V.info) toggleInfo(false); else closeViewer(); }
  else if (k === 'ArrowRight') step(1);
  else if (k === 'ArrowLeft') step(-1);
  else if (k === 'f' || k === 'F' || k === '.') fav();
  else if (k === 'i' || k === 'I') toggleInfo();
  else if (k === 'e' || k === 'E') edit();
  else if (k === 'Delete') del();
  else if (k === ' ') {
    // com foco num botão, o Espaço aciona o botão
    if (t.closest?.('button')) return;
    e.preventDefault();
    const vid = V.cur.querySelector('video');
    vid ? togglePlay(vid) : toggleChrome();
  }
  else if (k === '+' || k === '=') zoomAt(1.5, innerWidth / 2, innerHeight / 2, true);
  else if (k === '-') zoomAt(1 / 1.5, innerWidth / 2, innerHeight / 2, true);
  else if (k === '0') resetZoom(true);
  else return;
  e.stopPropagation();
}
