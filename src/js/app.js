// Fotos — casca do app: barra lateral, barra superior/inferior, rotas e as telas da biblioteca.

import { api, native, thumbUrl } from './api.js';
import { $, h, icon, fmt, nf, norm, plural, debounce, MESES } from './util.js';
import {
  S, save, saveQuiet, flushSave, onChange, loadData, setItems, library, SETS, MEDIA_TYPES, UTILITIES, setItemsFor, months, years, recentDays,
  keyPhoto, memories, trips, albumById, albumItems, search, suggestions, toggleFav, setHidden, softDelete, recover,
  createAlbum, addToAlbum, removeFromAlbum, purgeOld, dropRefs, isFav, editV, isDeleted, isHidden, featured, placeLabel,
  resolvePlace, rangeLabel, duplicates, derive,
} from './store.js';
import { VGrid } from './grid.js';
import { menu, alertBox, prompt, confirmBox, sheet, toast, switchEl, segmented } from './ui.js';
import { openViewer } from './viewer.js';
import { playMemory } from './memories.js';
import { mapView } from './map.js';

const R = {
  route: { view: 'library', mode: 'all' },
  back: [],
  grid: null,
  selecting: false,
  sel: new Set(),
  unlocked: false,
  cleanup: [],
  title: ['', ''], // título da barra superior: sobrevive ao renderChrome
  tbFade: false, // telas com título grande: o pequeno da barra só aparece depois de rolar
  head: null, // { title, sub } da grade atual, para atualizar as contagens depois de um save
  preSearch: null, // rota de onde a busca saiu (Esc volta para ela)
  libMode: 'all',
};
window.__fotos = { R, S };

const view = $('#view'), toolbar = $('#toolbar'), bottom = $('#bottom'), mainEl = $('#main');
const ZOOM = [520, 380, 270, 200, 150, 112, 84, 62, 44, 32];

// ============ tema ============
function applyTheme() {
  const t = S.data.settings.theme;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('fotos-theme', JSON.stringify(t)); } catch {}
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ============ janela ============
function wireWindow() {
  const w = api.win;
  if (w) {
    document.documentElement.classList.add('win-frameless');
    $('.w-close').onclick = async () => { await flushSave(); w.close(); };
    w.onCloseRequested?.(async e => { e.preventDefault(); await flushSave(); w.destroy(); });
    $('.w-min').onclick = () => w.minimize();
    $('.w-max').onclick = () => w.toggleMaximize();
    // maximizada ou em tela cheia, a janela encosta nas bordas da tela: cantos retos
    const sync = async () => {
      const [max, full] = await Promise.all([w.isMaximized(), w.isFullscreen()]);
      document.documentElement.classList.toggle('win-square', max || full);
      const b = $('.w-max');
      b.title = max ? 'Restaurar' : 'Maximizar';
      b.firstElementChild.innerHTML = max
        ? '<rect x="2" y="3.6" width="6.4" height="6.4" rx="1.6" /><path d="M4.2 2h4.2A1.6 1.6 0 0 1 10 3.6v4.2" />'
        : '<rect x="2" y="2" width="8" height="8" rx="2.2" />';
    };
    w.onResized(sync);
    sync();
  }
  $('#side-toggle').append(icon('sidebar'));
  $('#side-toggle').onclick = toggleSidebar;
  $('#search-ic').replaceWith(icon('search'));
  applySize(true);
}

// ============ tamanho da janela: iPhone / iPad / Mac ============
// iPhone (< 700 px) e iPad (< 1100 px): sem barra lateral fixa, com as abas Biblioteca/Coleções embaixo;
// a barra lateral (álbuns, busca) abre por cima. Mac: barra lateral fixa.
const sizeOf = w => (w < 700 ? 'phone' : w < 1100 ? 'tablet' : 'desktop');
const compact = () => document.documentElement.dataset.size !== 'desktop';
function applySize(first) {
  const html = document.documentElement;
  const sz = sizeOf(innerWidth);
  if (html.dataset.size === sz) return;
  html.classList.add('size-switch');
  requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('size-switch')));
  html.dataset.size = sz;
  document.body.classList.remove('side-open');
  // no desktop, respeita a barra lateral que a pessoa ocultou
  document.body.classList.toggle('side-off', sz !== 'desktop' || !!S.data.settings.sideOff);
  if (!first) renderChrome();
}
addEventListener('resize', () => applySize(false));
$('#side-scrim').onclick = () => document.body.classList.remove('side-open');
function toggleSidebar() {
  if (compact()) return document.body.classList.toggle('side-open');
  S.data.settings.sideOff = document.body.classList.toggle('side-off');
  saveQuiet();
  renderChrome();
}

// ============ navegação ============
export function go(route, push = false) {
  if (route.view === 'search' && R.route.view !== 'search') R.preSearch = R.route;
  if (push) R.back.push({ route: R.route, scroll: view.querySelector('.scroller')?.scrollTop });
  else R.back = [];
  endSelect(false);
  relockIfLeaving(route);
  R.route = route;
  if (route.view === 'library') R.libMode = route.mode || 'all';
  // na busca, a barra lateral (onde fica o campo) continua aberta no phone/tablet: fechar escondia o que se digita
  if (route.view !== 'search') {
    document.body.classList.remove('side-open');
    if (searchInput.value) searchInput.value = '';
  }
  renderView();
  renderNav();
}
function goBack() {
  const b = R.back.pop();
  if (!b) return;
  endSelect(false);
  relockIfLeaving(b.route);
  R.route = b.route;
  renderView(b.scroll);
  renderNav();
}

const sameRoute = (a, b) => a.view === b.view && (a.key ?? a.id ?? a.path ?? '') === (b.key ?? b.id ?? b.path ?? '');

// ============ barra lateral ============
let navActiveDone = false;
function navItem(ic, label, route, count) {
  // Mapa e Vídeos aparecem em duas seções: só o primeiro fica destacado (a bolha não pula)
  const active = !navActiveDone && (sameRoute(R.route, route) || (route.view === 'library' && R.route.view === 'library'));
  if (active) navActiveDone = true;
  return h('button.nav-item' + (active ? '.active' : ''), { onclick: () => go(route), oncontextmenu: e => navContext(e, route) },
    icon(ic), h('span.lbl', label), count != null ? h('span.cnt', nf.format(count)) : null);
}
function navSection(id, title, kids, extra) {
  const collapsed = S.data.settings.collapsed?.[id];
  const sec = h('div.nav-sec' + (collapsed ? '.collapsed' : ''),
    h('div.nav-head', h('span', title), h('span', { style: { display: 'flex', gap: '2px' } }, extra,
      h('button.chev', { title: collapsed ? 'Expandir' : 'Recolher', onclick: () => {
        S.data.settings.collapsed = { ...(S.data.settings.collapsed || {}), [id]: !collapsed };
        // só a barra lateral muda: save() com emit refazia a grade e as telas inteiras
        saveQuiet();
        renderNav();
      } }, icon('down')))),
    h('div.nav-list', kids));
  return sec;
}
function pinnedEntry(k) {
  if (k.startsWith('album:')) {
    const a = albumById(k.slice(6));
    return a && { ic: 'album', label: a.name, route: { view: 'album', id: a.id }, items: () => albumItems(a) };
  }
  if (k === 'map') return { ic: 'map', label: 'Mapa', route: { view: 'map' }, items: () => SETS.located.get() };
  const s = SETS[k];
  return s && { ic: s.icon, label: s.title, route: { view: 'set', key: k }, items: s.get, locked: s.locked };
}

function renderNav() {
  const nav = $('#nav');
  const st = nav.scrollTop;
  navActiveDone = false;
  nav.replaceChildren(
    h('div.nav-list', navItem('library', 'Biblioteca', { view: 'library', mode: R.route.mode || 'all' }), navItem('collections', 'Coleções', { view: 'collections' })),
    navSection('pinned', 'Fixados', S.data.pinned.map(pinnedEntry).filter(Boolean).map(p => navItem(p.ic, p.label, p.route))),
    navSection('col', 'Coleções', [
      navItem('memories', 'Memórias', { view: 'memories' }),
      navItem('calendar', 'Dias Recentes', { view: 'days' }),
      navItem('trips', 'Viagens', { view: 'trips' }),
      navItem('star', 'Em Destaque', { view: 'set', key: 'featured' }),
      navItem('map', 'Mapa', { view: 'map' }),
    ]),
    navSection('albums', 'Álbuns', S.data.albums.map(a => navItem('album', a.name, { view: 'album', id: a.id })),
      h('button', { title: 'Novo álbum', onclick: () => newAlbum() }, icon('plus'))),
    navSection('types', 'Tipos de Mídia', MEDIA_TYPES.map(k => [k, SETS[k].get().length]).filter(([, n]) => n).map(([k, n]) => navItem(SETS[k].icon, SETS[k].title, { view: 'set', key: k }, n))),
    navSection('utils', 'Utilidades', visibleUtilities().map(k => navItem(SETS[k].icon, SETS[k].title, { view: 'set', key: k }, SETS[k].locked ? null : SETS[k].get().length))),
    navSection('folders', 'Pastas', S.data.folders.map(f => navItem('folder', f.split('\\').filter(Boolean).pop() || f, { view: 'folder', path: f })),
      h('button', { title: 'Adicionar pasta', onclick: addFolder }, icon('plus'))),
  );
  nav.scrollTop = st;
}

// como no iOS: Importações e Duplicados só aparecem quando têm algo (os trancados sempre)
const visibleUtilities = () => UTILITIES.filter(k => SETS[k].locked || SETS[k].get().length || (R.route.view === 'set' && R.route.key === k));

function navContext(e, route) {
  e.preventDefault();
  const items = [];
  if (route.view === 'album') {
    const a = albumById(route.id);
    const key = 'album:' + a.id;
    items.push(
      { label: 'Renomear Álbum', icon: 'edit', run: () => renameAlbum(a) },
      { label: S.data.pinned.includes(key) ? 'Desafixar' : 'Fixar', icon: 'pin', run: () => togglePin(key) },
      '-',
      { label: 'Apagar Álbum', icon: 'trash', danger: true, run: () => deleteAlbum(a) },
    );
  } else if (route.view === 'set' || route.view === 'map') {
    const key = route.view === 'map' ? 'map' : route.key;
    items.push({ label: S.data.pinned.includes(key) ? 'Desafixar' : 'Fixar em Coleções', icon: 'pin', run: () => togglePin(key) });
  } else if (route.view === 'folder') {
    items.push({ label: 'Mostrar no Explorador', icon: 'explorer', run: () => openFolder(route.path) },
      { label: 'Remover da Biblioteca', icon: 'minus', danger: true, run: () => removeFolder(route.path) });
  } else return;
  menu(items, { x: e.clientX, y: e.clientY });
}
function togglePin(key) {
  const p = S.data.pinned;
  p.includes(key) ? p.splice(p.indexOf(key), 1) : p.push(key);
  save();
}

// ============ barra superior / inferior ============
function setTitle(title, sub) {
  R.title = [title || '', sub || ''];
  const t = toolbar.querySelector('.tb-title');
  if (!t) return;
  t.firstChild.textContent = R.title[0];
  t.lastChild.textContent = R.title[1];
}
/** título pequeno da barra: some inteiro (título e subtítulo) enquanto o grande está à vista */
function tbFade(hide) {
  R.tbFade = hide;
  const t = toolbar.querySelector('.tb-title');
  if (t) t.style.opacity = hide ? 0 : 1;
}

// open_path deixou de existir: pasta → openFolder, link https → openUrl (com recuo para o api.js antigo)
const openFolder = p => api.openFolder?.(p) ?? api.openPath?.(p);
const openUrl = u => api.openUrl?.(u) ?? api.openPath?.(u);

function renderChrome() {
  const r = R.route;
  const left = [];
  if (document.body.classList.contains('side-off')) {
    left.push(h('div.pill.glass', h('button.gbtn.round', { title: 'Mostrar barra lateral', onclick: toggleSidebar }, icon('sidebar'))));
  }
  if (R.back.length) left.push(h('div.pill.glass', h('button.gbtn.round', { title: 'Voltar', onclick: goBack }, icon('back'))));
  const title = h('div.tb-title', { style: { opacity: R.tbFade ? 0 : 1 } }, h('b', R.title[0]), h('span', R.title[1]));
  const right = [];
  const isGrid = !!R.grid;
  if (R.selecting) {
    right.push(h('div.pill.glass', h('button.gbtn.sel-all', { onclick: () => selectAll() }, R.sel.size && R.sel.size === R.grid?.items.length ? 'Desmarcar Tudo' : 'Selecionar Tudo')),
      h('div.pill.glass', h('button.gbtn', { onclick: () => endSelect() }, 'Cancelar')));
  } else {
    if (isGrid) {
      right.push(h('div.pill.glass',
        // zoom(+1) = mais colunas = fotos menores, igual aos atalhos Ctrl − / Ctrl +
        h('button.gbtn.round', { title: 'Diminuir (Ctrl −)', onclick: () => zoom(1) }, icon('zoomOut')),
        h('button.gbtn.round', { title: 'Aumentar (Ctrl +)', onclick: () => zoom(-1) }, icon('zoomIn'))));
      right.push(h('div.pill.glass', h('button.gbtn.sel-btn', { title: 'Selecionar', onclick: startSelect }, icon('selectCircle'), h('span', 'Selecionar'))));
    }
    right.push(h('div.pill.glass', h('button.gbtn.round', { title: 'Mais', onclick: e => moreMenu(e.currentTarget) }, icon('more'))));
  }
  toolbar.replaceChildren(...left, title, h('div.drag', { 'data-tauri-drag-region': '' }), ...right);

  // inferior
  const b = [];
  if (R.selecting) b.push(selBar());
  else {
    if (r.view === 'library') b.push(segmented([{ value: 'years', label: 'Anos' }, { value: 'months', label: 'Meses' }, { value: 'all', label: 'Todas' }], r.mode, mode => go({ view: 'library', mode })));
    if (document.body.classList.contains('side-off')) {
      // a aba Biblioteca volta ao modo em que a pessoa estava (Anos/Meses/Todas)
      b.unshift(segmented([{ value: 'library', label: 'Biblioteca', icon: 'library' }, { value: 'collections', label: 'Coleções', icon: 'collections' }],
        r.view === 'library' ? 'library' : r.view === 'collections' ? 'collections' : '', v => go(v === 'library' ? { view: 'library', mode: R.libMode } : { view: 'collections' }), 'tabbar'));
      b.push(h('button.search-orb.glass.lift', { title: 'Buscar', onclick: openSearch }, icon('search')));
    }
  }
  bottom.replaceChildren(...b);
}

function moreMenu(anchor) {
  const r = R.route;
  const items = [];
  if (R.grid) {
    items.push({ label: 'Proporção Original', tick: S.data.settings.aspect, run: () => { S.data.settings.aspect = !S.data.settings.aspect; save(); R.grid.setAspect(S.data.settings.aspect); } });
  }
  if (r.view === 'album') {
    const a = albumById(r.id);
    items.push('-', { label: 'Reproduzir Memória', icon: 'slideshow', run: () => playMemory({ title: a.name, subtitle: fmt.items(a.items.length), items: albumItems(a) }) },
      { label: 'Renomear Álbum', icon: 'edit', run: () => renameAlbum(a) },
      { label: S.data.pinned.includes('album:' + a.id) ? 'Desafixar' : 'Fixar em Coleções', icon: 'pin', run: () => togglePin('album:' + a.id) },
      { label: 'Apagar Álbum', icon: 'trash', danger: true, run: () => deleteAlbum(a) });
  }
  if (r.view === 'set' && r.key === 'deleted' && R.grid?.items.length) {
    items.push('-', { label: 'Recuperar Tudo', icon: 'restore', run: () => recoverAll(R.grid.items.map(i => i.id)) },
      { label: 'Apagar Tudo', icon: 'trash', danger: true, run: () => deleteForever(R.grid.items.map(i => i.id)) });
  }
  if (R.grid?.items.length && r.view !== 'set') items.push({ label: 'Apresentação', icon: 'slideshow', run: () => playMemory({ title: currentTitle(), items: R.grid.items.slice(-60) }) });
  items.push('-',
    { label: 'Buscar Novas Fotos', icon: 'restore', run: () => rescan(true) },
    { label: 'Importar Pasta…', icon: 'import', run: importFolder },
    { label: 'Definir como App Padrão…', icon: 'photos', run: setAsDefault },
    { label: 'Ajustes…', icon: 'gear', run: settings });
  menu(items, anchor);
}

// como no iOS, Recuperar Tudo pede confirmação
async function recoverAll(ids) {
  if (!(await confirmBox(`Recuperar ${plural(ids.length, 'item', 'itens')}?`, 'Eles voltam para a biblioteca.', 'Recuperar', false))) return;
  recover(ids);
  toast(plural(ids.length, 'item recuperado', 'itens recuperados'), 'restore');
}

function currentTitle() {
  const r = R.route;
  if (r.view === 'album') return albumById(r.id)?.name;
  if (r.view === 'set') return SETS[r.key]?.title;
  return 'Fotos';
}

// ============ zoom ============
function colsFor(width, z) {
  return Math.max(1, Math.round(width / ZOOM[Math.max(0, Math.min(ZOOM.length - 1, z))]));
}
function zoom(d) {
  // sem grade na tela (Coleções, Anos, Meses), o zoom mudava escondido e redesenhava a tela à toa
  if (!R.grid) return;
  const s = S.data.settings;
  const z = Math.max(0, Math.min(ZOOM.length - 1, s.zoom + d));
  if (z === s.zoom) return;
  s.zoom = z;
  saveQuiet();
  R.grid.setCols(colsFor(R.grid.host.clientWidth, s.zoom));
}
let wheelAcc = 0;
view.addEventListener('wheel', e => {
  if (!e.ctrlKey || !R.grid) return;
  e.preventDefault();
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) > 40) {
    zoom(wheelAcc > 0 ? 1 : -1);
    wheelAcc = 0;
  }
}, { passive: false });

// ============ seleção ============
function startSelect() {
  R.selecting = true;
  R.sel.clear();
  view.classList.add('selecting');
  renderChrome();
}
function endSelect(redraw = true) {
  if (!R.selecting && !R.sel.size) return;
  R.selecting = false;
  R.sel.clear();
  view.classList.remove('selecting');
  R.grid?.syncSelection();
  if (redraw) renderChrome();
}
/** `toggle`: o botão alterna; o Ctrl+A sempre seleciona tudo (como no Windows e no macOS) */
function selectAll(toggle = true) {
  if (!R.grid) return;
  if (toggle && R.sel.size === R.grid.items.length) R.sel.clear();
  else R.grid.items.forEach(i => R.sel.add(i.id));
  R.grid.syncSelection();
  onSel();
}
function onSel() {
  if (!R.selecting) {
    R.selecting = true;
    view.classList.add('selecting');
    return renderChrome();
  }
  // a barra já existe: só atualiza contagem e botões (recriar fazia a animação de entrada tocar a cada clique)
  const bar = bottom.querySelector('.selbar');
  if (!bar) return renderChrome();
  updateSelBar(bar);
}

/** "1 Foto Selecionada", "3 Vídeos Selecionados", "5 Itens Selecionados" (como no iOS) */
function selLabel(ids) {
  const n = ids.length;
  if (!n) return 'Selecione itens';
  const its = ids.map(id => S.byId.get(id)).filter(Boolean);
  const [um, varios] = its.length && its.every(i => i.video) ? ['Vídeo Selecionado', 'Vídeos Selecionados']
    : its.length && its.every(i => !i.video) ? ['Foto Selecionada', 'Fotos Selecionadas'] : ['Item Selecionado', 'Itens Selecionados'];
  return plural(n, um, varios);
}

function updateSelBar(bar) {
  const ids = [...R.sel];
  const none = !ids.length;
  bar.querySelector('.count').textContent = selLabel(ids);
  bar.querySelectorAll('button').forEach(b => (b.disabled = none));
  const fb = bar.querySelector('.fav-btn');
  if (fb) {
    const allFav = !none && ids.every(id => S.data.favorites[id]);
    fb.title = allFav ? 'Desfavoritar' : 'Favoritar';
    fb.replaceChildren(icon(allFav ? 'heartFill' : 'heart'));
  }
  const sa = toolbar.querySelector('.sel-all');
  if (sa) sa.textContent = R.sel.size && R.sel.size === R.grid?.items.length ? 'Desmarcar Tudo' : 'Selecionar Tudo';
}

function selBar() {
  // os botões leem R.sel na hora do clique: a barra não é mais recriada a cada item marcado
  const ids = () => [...R.sel];
  const r = R.route;
  const count = h('div.count');
  let bar;
  if (r.view === 'set' && r.key === 'deleted') {
    bar = h('div.selbar.glass', h('button.gbtn', { onclick: () => { recover(ids()); endSelect(); } }, 'Recuperar'), count,
      h('button.gbtn.danger', { onclick: () => deleteForever(ids()) }, 'Apagar'));
  } else {
    bar = h('div.selbar.glass',
      h('button.gbtn.round', { title: 'Exportar', onclick: () => exportItems(ids()) }, icon('share')),
      h('button.gbtn.round.fav-btn', { onclick: () => { const x = ids(); toggleFav(x, !x.every(id => S.data.favorites[id])); R.grid.refresh(); updateSelBar(bar); } }),
      count,
      h('button.gbtn.round', { title: 'Adicionar ao Álbum', onclick: () => pickAlbum(ids()) }, icon('album')),
      h('button.gbtn.round', { title: 'Mais', onclick: e => menu(selMenu(ids()), e.currentTarget) }, icon('more')),
      h('button.gbtn.round.danger', { title: 'Apagar', onclick: () => trashFromBar(ids()) }, icon('trash')));
  }
  updateSelBar(bar);
  return bar;
}

/** num álbum, a lixeira pergunta como no iOS: tirar só do álbum ou apagar da biblioteca */
async function trashFromBar(ids) {
  const r = R.route;
  if (r.view !== 'album') return deleteItems(ids);
  const i = await alertBox({
    title: ids.length === 1 ? 'Remover este item?' : `Remover ${plural(ids.length, 'item', 'itens')}?`,
    message: 'Remover do Álbum mantém o item na biblioteca. Apagar leva para Apagados Recentemente.',
    buttons: [{ label: 'Cancelar' }, { label: 'Remover do Álbum', primary: true }, { label: 'Apagar', destructive: true }],
  });
  if (i === 1) { removeFromAlbum(r.id, ids); endSelect(); }
  else if (i === 2) deleteItems(ids);
}

function selMenu(ids) {
  const r = R.route;
  const hidden = r.view === 'set' && r.key === 'hidden';
  return [
    r.view === 'album' && { label: 'Remover do Álbum', icon: 'minus', run: () => { removeFromAlbum(r.id, ids); endSelect(); } },
    { label: hidden ? 'Reexibir' : 'Ocultar', icon: 'hidden', run: () => { setHidden(ids, !hidden); endSelect(); toast(hidden ? plural(ids.length, 'item reexibido', 'itens reexibidos') : plural(ids.length, 'item ocultado', 'itens ocultados'), 'hidden'); } },
    { label: 'Novo Álbum com Seleção', icon: 'plus', run: () => newAlbum(ids) },
    { label: 'Apresentação', icon: 'slideshow', run: () => playMemory({ title: fmt.items(ids.length), items: ids.map(id => S.byId.get(id)) }) },
  ];
}

// ============ ações ============
/** resolve com true quando os itens saíram da lista atual (o visualizador usa para avançar) */
export async function deleteItems(ids) {
  const n = ids.length;
  // já estão em Apagados: apagar de novo reiniciava o prazo de 30 dias. Oferece Recuperar ou Apagar Agora.
  if (n && ids.every(id => S.data.deleted[id])) return deletedChoice(ids);
  const first = S.byId.get(ids[0]);
  const okLabel = n === 1 ? (first?.video ? 'Apagar Vídeo' : 'Apagar Foto') : `Apagar ${n} Itens`;
  const what = n === 1 ? (first?.video ? 'Este vídeo ficará' : 'Esta foto ficará') : 'Os itens ficarão';
  const ok = await confirmBox(n === 1 ? 'Apagar este item?' : `Apagar ${n} itens?`, `${what} em Apagados Recentemente por 30 dias. Depois disso, ${n === 1 ? 'vai' : 'vão'} para a Lixeira do Windows.`, okLabel);
  if (!ok) return false;
  softDelete(ids);
  endSelect();
  toast(n === 1 ? 'Movido para Apagados Recentemente' : `${n} itens movidos para Apagados Recentemente`, 'trash');
  return true;
}
async function deletedChoice(ids) {
  const n = ids.length;
  const i = await alertBox({
    title: n === 1 ? 'Este item já está em Apagados Recentemente' : `${n} itens já estão em Apagados Recentemente`,
    message: 'Recupere para a biblioteca ou apague agora (vai para a Lixeira do Windows).',
    buttons: [{ label: 'Cancelar' }, { label: 'Recuperar', primary: true }, { label: 'Apagar Agora', destructive: true }],
  });
  if (i === 1) {
    recover(ids);
    endSelect();
    toast(plural(n, 'item recuperado', 'itens recuperados'), 'restore');
    return true;
  }
  return i === 2 ? deleteForever(ids, true) : false;
}
async function deleteForever(ids, confirmed = false) {
  const n = ids.length;
  if (!confirmed && !(await confirmBox(n === 1 ? 'Apagar este item agora?' : `Apagar ${n} itens agora?`, 'Os arquivos serão movidos para a Lixeira do Windows.', 'Apagar'))) return false;
  try {
    await api.trash(ids);
    for (const id of ids) dropRefs(id);
    S.all = S.all.filter(i => !ids.includes(i.id));
    ids.forEach(id => S.byId.delete(id));
    save(true);
    endSelect();
    toast(n === 1 ? 'Movido para a Lixeira do Windows' : `${n} itens movidos para a Lixeira do Windows`, 'trash');
    return true;
  } catch (e) {
    alertBox({ title: 'Não foi possível apagar', message: String(e) });
    return false;
  }
}
export async function exportItems(ids) {
  const r = await api.exportItems(ids.map(id => [id, !!S.data.edits[id]]));
  if (r != null) toast(`${fmt.items(r)} exportado${r === 1 ? '' : 's'}`, 'share');
  else if (!native) toast('Exportar funciona no app instalado', 'info');
}
export async function newAlbum(ids = []) {
  const name = await prompt('Novo Álbum', '', 'Título', 'Salvar');
  if (name == null) return;
  const a = createAlbum(name || 'Novo Álbum', ids);
  endSelect();
  if (ids.length) toast(`Adicionado a “${a.name}”`, 'album');
  else go({ view: 'album', id: a.id });
}
async function renameAlbum(a) {
  const name = await prompt('Renomear Álbum', a.name);
  if (name) { a.name = name; save(); }
}
async function deleteAlbum(a) {
  if (!(await confirmBox(`Apagar “${a.name}”?`, 'As fotos continuam na biblioteca.', 'Apagar Álbum'))) return;
  S.data.albums = S.data.albums.filter(x => x !== a);
  S.data.pinned = S.data.pinned.filter(k => k !== 'album:' + a.id);
  save();
  if (R.route.view === 'album' && R.route.id === a.id) go({ view: 'collections' });
}
export function pickAlbum(ids) {
  sheet((el, close) => {
    const list = h('div.grp.picker-list',
      h('button.row', { onclick: () => { close(); newAlbum(ids); } }, icon('plus'), h('span.lbl', 'Novo Álbum…')),
      S.data.albums.map(a => {
        const cover = albumItems(a).at(-1);
        return h('button.row', { onclick: () => { addToAlbum(a.id, ids); close(); endSelect(); toast(`Adicionado a “${a.name}”`, 'album'); } },
          cover ? h('img', { src: thumbUrl(cover, 200, editV(cover), true) }) : icon('album'), h('span.lbl', a.name), h('span.val', nf.format(albumItems(a).length)));
      }));
    el.append(h('h2', 'Adicionar ao Álbum'), h('p.sub', fmt.items(ids.length)), list, h('div.foot', h('button.gbtn', { onclick: close }, 'Cancelar')));
  });
}

// ============ pastas e indexação ============
let scanning = false;
let progressEl;
async function rescan(force) {
  if (scanning) return;
  scanning = true;
  if (!S.all.length) renderView();
  if (force) showProgress(0, 0);
  try {
    const items = await api.scan(S.data.folders);
    setItems(items);
    await purgeOld();
  } catch (e) {
    console.error(e);
  } finally {
    scanning = false;
    hideProgress();
    lastScan = Date.now();
  }
}
let lastScan = 0;
api.on('scan-progress', ([done, total]) => {
  if (!scanning || total < 200) return;
  if (done < total) showProgress(done, total);
});
function showProgress(done, total) {
  if (!progressEl) {
    progressEl = h('div.progress.glass', h('span', 'Indexando'), h('div.bar', h('i')), h('span.n', ''));
    mainEl.append(progressEl);
  }
  progressEl.classList.remove('out');
  progressEl.querySelector('i').style.width = total ? (done / total) * 100 + '%' : '8%';
  progressEl.querySelector('.n').textContent = total ? `${nf.format(done)} de ${nf.format(total)}` : '';
}
function hideProgress() {
  progressEl?.classList.add('out');
}
async function addFolder() {
  const f = await api.pickFolder();
  if (!f || S.data.folders.includes(f)) return;
  S.data.folders.push(f);
  save();
  rescan(true);
}
function removeFolder(f) {
  S.data.folders = S.data.folders.filter(x => x !== f);
  save();
  rescan(true);
}
async function importFolder() {
  const f = await api.pickFolder();
  if (f) importPaths([f]);
}
async function importPaths(paths) {
  if (!native || !S.data.folders.length) return;
  try {
    // conta antes: o que já está na biblioteca é ignorado, e muita coisa pede confirmação
    const [total, bytes] = await api.importPreview(paths, S.data.folders[0]);
    if (!total) return toast('Nada para importar: já está na biblioteca', 'import');
    if ((total > 200 || bytes > 2 * 1024 ** 3) && !(await confirmBox(`Importar ${fmt.items(total)}?`, `São ${fmt.bytes(bytes)}. Eles serão copiados para a pasta Importados.`, 'Importar', false))) return;
    showProgress(0, 0);
    const n = await api.importPaths(paths, S.data.folders[0]);
    toast(n ? `${fmt.items(n)} importado${n > 1 ? 's' : ''}` : 'Nada para importar', 'import');
    if (n) await rescan(true);
  } catch (e) {
    alertBox({ title: 'Não foi possível importar', message: String(e) });
  } finally {
    hideProgress();
  }
}

// ============ ajustes ============
function settings() {
  sheet((el, close) => {
    const st = S.data.settings;
    const theme = h('div.segsmall', [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([v, l]) =>
      h('button' + (st.theme === v ? '.on' : ''), { onclick: e => { st.theme = v; save(); applyTheme(); [...e.target.parentNode.children].forEach(b => b.classList.toggle('on', b === e.target)); } }, l)));
    const folders = h('div.grp');
    const drawFolders = () => folders.replaceChildren(
      ...S.data.folders.map(f => h('div.row', icon('folder'), h('span.lbl', { title: f }, f), h('button.gbtn.round.x', { title: 'Remover', onclick: () => { removeFolder(f); drawFolders(); } }, icon('minus')))),
      h('button.row', { onclick: async () => { await addFolder(); drawFolders(); } }, icon('folderPlus'), h('span.lbl', { style: { color: 'var(--accent)' } }, 'Adicionar Pasta…')));
    drawFolders();
    el.append(
      h('h2', 'Ajustes'), h('p.sub', `${fmt.count(library().filter(i => !i.video).length, library().filter(i => i.video).length)} na biblioteca`),
      h('div.grp-t', 'Pastas da Biblioteca'), folders,
      h('div.grp-t', 'App Padrão'),
      h('div.grp', defaultRow()),
      h('div.grp-t', 'Geral'),
      h('div.grp',
        h('div.row', icon('sun'), h('span.lbl', 'Aparência'), theme),
        h('div.row', icon('lock'), h('span.lbl', 'Usar Windows Hello para Ocultos e Apagados'), switchEl(st.hello, v => { st.hello = v; save(); })),
        h('div.row', icon('location'), h('span.lbl', 'Nomes de lugares (OpenStreetMap)'), switchEl(st.places, v => { st.places = v; save(); })),
        h('div.row', icon('aspect'), h('span.lbl', 'Mostrar proporção original na grade'), switchEl(st.aspect, v => { st.aspect = v; save(); R.grid?.setAspect(v); }))),
      h('div.foot', h('button.gbtn.accent', { onclick: close }, 'OK')),
      h('p.credit', 'Fotos · Criado pela ', h('a', { href: '#', onclick: e => { e.preventDefault(); openUrl('https://devlumo.com.br'); } }, 'DevLumo')));
  });
}

// ============ app padrão do Windows ============
function defaultRow() {
  const val = h('span.val', '');
  const row = h('div.row', icon('photos'), h('span.lbl', 'Abrir fotos e vídeos com o Fotos'), val,
    h('button.gbtn.accent', { onclick: setAsDefault }, 'Definir…'));
  api.defaultStatus().then(st => {
    val.textContent = st.photos && st.videos ? 'Já é o padrão' : st.photos ? 'Padrão para fotos' : st.videos ? 'Padrão para vídeos' : '';
  });
  return row;
}
async function setAsDefault() {
  if (!native) return toast('Funciona no app instalado', 'info');
  const i = await alertBox({
    title: 'Definir o Fotos como padrão',
    message: 'O Windows vai abrir Aplicativos padrão já na página do Fotos. Clique em “Definir padrão” no topo (ou escolha o Fotos em cada tipo de arquivo, como .jpg, .heic e .mp4).',
    buttons: [{ label: 'Cancelar' }, { label: 'Abrir Configurações', primary: true }],
  });
  if (i === 1) api.openDefaultSettings();
}

/** abre um arquivo (duplo clique no Explorador) no visualizador, com as fotos da mesma pasta */
async function openFromPath(path) {
  try {
    const [items, index] = await api.openFile(path);
    if (!items.length) return;
    derive(items);
    // usa o mesmo objeto da biblioteca quando a foto já está nela (favoritos, edições…)
    // fora da biblioteca: o visualizador desativa favoritar/ocultar/álbum e "Apagar" vai direto para a Lixeira
    const list = items.map(i => S.byId.get(i.id) || Object.assign(i, { external: true }));
    openViewer(list, index, {});
  } catch (e) {
    alertBox({ title: 'Não foi possível abrir', message: String(e) });
  }
}

// ============ busca ============
function openSearch() {
  if (compact()) document.body.classList.add('side-open');
  else if (document.body.classList.contains('side-off')) toggleSidebar();
  setTimeout(() => $('#search').focus(), 60);
}
const searchInput = $('#search');
/** sai da busca para a tela de onde ela foi aberta (não sempre para a Biblioteca) */
function leaveSearch() {
  const back = R.preSearch && R.preSearch.view !== 'search' ? R.preSearch : { view: 'library', mode: R.libMode };
  R.preSearch = null;
  go(back);
}
searchInput.addEventListener('input', debounce(() => {
  const q = searchInput.value.trim();
  if (q) {
    if (R.route.view === 'search') { R.route.q = q; renderView(); }
    else go({ view: 'search', q });
  } else if (R.route.view === 'search') leaveSearch();
}, 180));
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    searchInput.blur();
    if (R.route.view === 'search') leaveSearch();
  } else if (e.key === 'Enter' && compact()) {
    // phone/tablet: Enter fecha a barra lateral para mostrar os resultados
    searchInput.blur();
    document.body.classList.remove('side-open');
  }
});

// ============ telas ============
function clearView() {
  R.cleanup.forEach(f => f());
  R.cleanup = [];
  R.grid?.destroy();
  R.grid = null;
  R.head = null;
  R.title = ['', ''];
  R.tbFade = false;
  view.replaceChildren();
  mainEl.classList.remove('scrolled');
}

function scroller() {
  const s = h('div.scroller');
  s.addEventListener('scroll', () => mainEl.classList.toggle('scrolled', s.scrollTop > 8), { passive: true });
  view.append(s);
  return s;
}

function emptyState(ic, title, text, action) {
  return h('div.empty', h('div.box', icon(ic), h('h2', title), h('p', text), action));
}

async function renderView(restoreScroll) {
  clearView();
  const r = R.route;
  renderChrome();
  if (!S.all.length && r.view !== 'collections' && r.view !== 'map') {
    view.append(emptyState('photos', scanning ? 'Carregando Fotos…' : 'Nenhuma Foto', scanning ? 'Lendo suas pastas de imagens.' : 'Adicione uma pasta com fotos e vídeos para começar.',
      scanning ? null : h('button.gbtn.accent', { onclick: addFolder }, icon('folderPlus'), 'Adicionar Pasta')));
    setTitle('Fotos', '');
    return;
  }
  if (r.view === 'library') {
    if (r.mode === 'years') return yearsView(restoreScroll);
    if (r.mode === 'months') return monthsView(restoreScroll);
    return gridView({ items: library(), title: null, bottom: true, restoreScroll, scrollTo: r.scrollTo });
  }
  if (r.view === 'collections') return collectionsView(restoreScroll);
  if (r.view === 'set') {
    const s = SETS[r.key];
    if (s.locked && S.data.settings.hello && !R.unlocked) return lockedView(s);
    const items = s.get();
    return gridView({
      items, title: s.title, sub: countSub, restoreScroll,
      badge: r.key === 'deleted' ? it => { const d = Math.max(0, 30 - Math.floor((Date.now() - S.data.deleted[it.id]) / 864e5)); return plural(d, 'dia', 'dias'); } : null,
      empty: r.key === 'deleted' ? ['trash', 'Nenhum Item Apagado', 'Fotos e vídeos apagados ficam aqui por 30 dias.'] : r.key === 'favorites' ? ['heart', 'Nenhum Favorito', 'Toque no coração de uma foto para vê-la aqui.'] : r.key === 'duplicates' ? ['duplicate', 'Nenhum Duplicado', 'Nenhuma cópia exata foi encontrada.'] : null,
      sub2: r.key === 'duplicates' ? `${plural(duplicates().length, 'grupo', 'grupos')} de cópias exatas (mesmo tamanho, dimensões e horário).` : null,
    });
  }
  if (r.view === 'album') {
    const a = albumById(r.id);
    if (!a) return go({ view: 'collections' });
    const items = albumItems(a);
    return gridView({ items, title: a.name, sub: countSub, restoreScroll, empty: ['album', 'Álbum Vazio', 'Selecione fotos na biblioteca e escolha “Adicionar ao Álbum”.'] });
  }
  if (r.view === 'day') {
    const items = library().filter(i => i.day === r.key);
    const d = new Date(items[0]?.t || Date.now());
    return gridView({ items, title: fmt.relDay(d), sub: list => `${fmt.day(d)} · ${fmt.items(list.length)}`, restoreScroll, newestLast: true });
  }
  if (r.view === 'trip') {
    const t = trips().find(t => t.id === r.id);
    if (!t) return go({ view: 'trips' });
    return gridView({ items: t.items, title: placeLabel(t.center) || 'Viagem', sub: rangeLabel(t.date, t.end), restoreScroll, newestLast: true, memory: { title: placeLabel(t.center) || 'Viagem', subtitle: rangeLabel(t.date, t.end), items: t.items } });
  }
  if (r.view === 'folder') {
    const items = folderItems(r.path);
    return gridView({ items, title: r.path.split('\\').filter(Boolean).pop(), sub: r.path, restoreScroll });
  }
  if (r.view === 'search') return searchView();
  if (r.view === 'memories') return memoriesView();
  if (r.view === 'days') return daysView();
  if (r.view === 'trips') return tripsView();
  if (r.view === 'map') {
    setTitle('Mapa', fmt.items(SETS.located.get().length));
    const wrap = h('div.mapwrap');
    view.append(wrap);
    R.cleanup.push(mapView(wrap, SETS.located.get(), (list, i) => openViewer(list, i, {})));
  }
}

/** contagem "N Fotos, M Vídeos" calculada da lista atual (o cabeçalho acompanha os saves) */
const countSub = list => fmt.count(list.filter(i => !i.video).length, list.filter(i => i.video).length);

/** itens de uma pasta; o separador no fim evita pegar pastas "irmãs" (C:\Fotos 2 em C:\Fotos) */
function folderItems(path) {
  const p = norm(path.replace(/[\\/]*$/, '\\'));
  return library().filter(i => norm(i.path).startsWith(p));
}

function lockedView(s) {
  setTitle(s.title, '');
  // Ocultos é um álbum no iOS; Apagados Recentemente não
  const album = s === SETS.hidden;
  view.append(h('div.empty.locked', h('div.box', icon('lock'), h('h2', `${s.title} está bloqueado`), h('p', album ? 'Use o Windows Hello para ver este álbum.' : `Use o Windows Hello para ver ${s.title}.`),
    h('button.gbtn.accent', { onclick: unlock }, album ? 'Ver Álbum' : 'Ver'))));
}
const VERIFY_MSG = {
  error: 'Não foi possível usar o Windows Hello.',
  busy: 'O Windows Hello está ocupado. Tente de novo.',
  policy: 'O Windows Hello está bloqueado por uma política deste PC.',
};
async function unlock() {
  const r = await api.verify('Desbloquear álbuns protegidos do Fotos');
  // libera só com 'ok' ou PC sem Hello configurado; 'cancel' não diz nada. O modo demonstração
  // (api.js no navegador) ainda devolve 'unavailable' e precisa abrir.
  if (r === 'ok' || r === 'not_configured' || (!native && r === 'unavailable')) {
    R.unlocked = true;
    renderView();
    renderNav();
  } else if (r !== 'cancel') toast(VERIFY_MSG[r] || VERIFY_MSG.error, 'lock');
}
const LOCKED = r => r.view === 'set' && !!SETS[r.key]?.locked;
/** como no iOS, Ocultos e Apagados trancam de novo ao sair deles */
function relockIfLeaving(next) {
  if (R.unlocked && !LOCKED(next)) R.unlocked = false;
}
// ...e quando a janela vai para segundo plano (minimizada)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden || !R.unlocked) return;
  R.unlocked = false;
  if (LOCKED(R.route) && !document.querySelector('.viewer')) { renderView(); renderNav(); }
});

/** tela de grade (biblioteca, álbuns, coleções) */
function gridView({ items, title, sub, sub2, bottom: startBottom, restoreScroll, scrollTo, badge, empty, newestLast, memory }) {
  const s = scroller();
  if (!items.length && empty) {
    view.append(emptyState(...empty));
    setTitle(title || 'Fotos', '');
    return;
  }
  let head = null;
  // `sub` pode ser função da lista: o onChange recalcula cabeçalho e barra depois de cada save
  const subOf = typeof sub === 'function' ? sub : () => sub;
  R.head = title ? { title, sub: typeof sub === 'function' ? sub : null } : null;
  sub = subOf(items);
  if (title) {
    head = h('div.grid-head', h('h1', title), sub ? h('p.sub', sub) : null, sub2 ? h('p', sub2) : null,
      memory ? h('button.gbtn.accent', { style: { marginTop: '12px' }, onclick: () => playMemory(memory) }, icon('play'), 'Reproduzir Memória') : null);
    s.append(head);
  } else {
    s.append(h('div', { style: { height: 'calc(var(--top-safe) - 8px)' } }));
  }
  const host = h('div');
  s.append(host);
  const nP = items.filter(i => !i.video).length;
  s.append(h('div.grid-foot', h('b', fmt.count(nP, items.length - nP)), title ? '' : lastUpdated()));
  const g = (R.grid = new VGrid({
    scroller: s, host, items, cols: colsFor(s.clientWidth - 0, S.data.settings.zoom), aspect: S.data.settings.aspect, badge,
    selection: R.sel, selecting: () => R.selecting,
    onSel, onOpen: (it, i, list) => openViewer(list, i, { grid: g, rect: g.tileRect(i) }),
    onContext: (it, i, e) => tileMenu(it, i, e),
    onScroll: (it, top) => {
      if (!it) return;
      if (!title) setTitle(fmt.monthYear(new Date(it.t)), placeLabel(it.lat != null ? it : null) || fmt.dayShort(new Date(it.t)));
      else if (R.tbFade !== !(top > -20)) tbFade(!(top > -20));
    },
  }));
  g.setAspect(S.data.settings.aspect);
  renderChrome();
  watchCols(g, host);
  if (title) setTitle(title, sub);
  if (restoreScroll != null) s.scrollTop = restoreScroll;
  else if (scrollTo != null) {
    const i = items.findIndex(x => x.t >= scrollTo);
    g.scrollToIndex(i < 0 ? items.length - 1 : i, 'top');
  } else if (startBottom || newestLast) g.scrollToBottom();
  g.render();
}

function lastUpdated() {
  return '';
}

function tileMenu(it, i, e) {
  const ids = R.sel.has(it.id) && R.sel.size > 1 ? [...R.sel] : [it.id];
  const multi = ids.length > 1;
  const r = R.route;
  const fav = ids.every(id => S.data.favorites[id]);
  if (r.view === 'set' && r.key === 'deleted') {
    return menu([{ label: 'Recuperar', icon: 'restore', run: () => recover(ids) }, { label: 'Apagar Agora', icon: 'trash', danger: true, run: () => deleteForever(ids) }], { x: e.clientX, y: e.clientY });
  }
  menu([
    !multi && { label: 'Abrir', icon: 'expand', run: () => openViewer(R.grid.items, i, { grid: R.grid, rect: R.grid.tileRect(i) }) },
    { label: fav ? 'Desfavoritar' : 'Favoritar', icon: fav ? 'heartFill' : 'heart', run: () => { toggleFav(ids, !fav); R.grid.refresh(); } },
    { label: 'Adicionar ao Álbum…', icon: 'album', run: () => pickAlbum(ids) },
    r.view === 'album' && { label: 'Remover do Álbum', icon: 'minus', run: () => removeFromAlbum(r.id, ids) },
    '-',
    { label: multi ? `Exportar ${ids.length} Itens…` : 'Exportar…', icon: 'share', run: () => exportItems(ids) },
    !multi && { label: 'Mostrar no Explorador', icon: 'explorer', run: () => api.reveal(it.id) },
    !multi && !it.video && { label: 'Usar como Papel de Parede', icon: 'wallpaper', run: () => setWallpaper(it) },
    '-',
    { label: isHidden(it) ? 'Reexibir' : 'Ocultar', icon: 'hidden', run: () => setHidden(ids, !isHidden(it)) },
    { label: 'Apagar', icon: 'trash', danger: true, run: () => deleteItems(ids) },
  ], { x: e.clientX, y: e.clientY });
}

export async function setWallpaper(it) {
  try {
    await api.setWallpaper(it.id, !!S.data.edits[it.id]);
    toast('Papel de parede definido', 'wallpaper');
  } catch (e) {
    alertBox({ title: 'Papel de parede', message: String(e) });
  }
}

// ---------- Anos ----------
function cycler(card, items) {
  const pick = items.filter(i => !i.shot).slice();
  if (pick.length < 2) return;
  const step = Math.max(1, Math.floor(pick.length / 6));
  const list = pick.filter((_, k) => k % step === 0).slice(0, 6);
  let k = 0, timer;
  const stop = () => { clearInterval(timer); timer = 0; };
  card.addEventListener('mouseenter', () => {
    stop();
    timer = setInterval(() => {
      // clicado, o cartão sai do DOM sem mouseleave: o intervalo seguia gerando miniaturas para sempre
      if (!card.isConnected) return stop();
      k = (k + 1) % list.length;
      const img = h('img', { src: thumbUrl(list[k], 720, editV(list[k])), class: 'out' });
      img.onload = () => {
        card.insertBefore(img, card.querySelector('.shade'));
        requestAnimationFrame(() => img.classList.remove('out'));
        const old = card.querySelectorAll('img');
        if (old.length > 2) old[0].remove();
      };
    }, 1500);
  });
  card.addEventListener('mouseleave', stop);
  card.addEventListener('click', stop);
  R.cleanup.push(stop);
}

function yearsView(restoreScroll) {
  const s = scroller();
  const ys = years();
  const wrap = h('div.cards.years');
  ys.forEach((y, k) => {
    const kp = keyPhoto(y.items);
    const card = h('button.ycard', { style: { animationDelay: Math.min(k, 8) * 40 + 'ms' }, onclick: () => go({ view: 'library', mode: 'months', year: y.key }, true) },
      h('img', { src: thumbUrl(kp, 720, editV(kp)), loading: 'lazy' }), h('div.shade'),
      h('div.t', h('b', String(y.key))), h('div.n', fmt.items(y.items.length)));
    cycler(card, y.items);
    wrap.append(card);
  });
  s.append(wrap);
  setTitle('Anos', plural(ys.length, 'ano', 'anos'));
  if (restoreScroll != null) s.scrollTop = restoreScroll;
  else s.scrollTop = s.scrollHeight;
}

// ---------- Meses ----------
function monthsView(restoreScroll) {
  const s = scroller();
  const ms = months();
  const wrap = h('div.cards.months');
  let target = null;
  ms.forEach((m, k) => {
    const kp = keyPhoto(m.items);
    const place = placeLabel(m.items.find(i => i.lat != null));
    const card = h('button.mcard', { style: { animationDelay: Math.max(0, k - ms.length + 12) * 30 + 'ms' }, onclick: () => go({ view: 'library', mode: 'all', scrollTo: m.items[0].t }, true) },
      h('img', { src: thumbUrl(kp, 720, editV(kp)), loading: 'lazy' }), h('div.shade'),
      h('div.t', h('b', fmt.month(m.date)), h('span', `${m.date.getFullYear()}${place ? ' · ' + place : ''}`)),
      h('div.n', fmt.items(m.items.length)));
    cycler(card, m.items);
    if (R.route.year === m.date.getFullYear() && !target) target = card;
    wrap.append(card);
  });
  s.append(wrap);
  setTitle('Meses', plural(ms.length, 'mês', 'meses'));
  if (restoreScroll != null) s.scrollTop = restoreScroll;
  else if (target) s.scrollTop = target.offsetTop - 80;
  else s.scrollTop = s.scrollHeight;
}

// ---------- Coleções ----------
function sec(title, onMore, ...kids) {
  return h('section.sec',
    h('div.sec-head', h('h2' + (onMore ? '.link' : ''), { onclick: onMore }, title, onMore ? icon('fwd') : null)),
    kids);
}
function dayCard(d) {
  const pics = d.items.filter(i => !i.shot);
  const src = (pics.length ? pics : d.items);
  const step = Math.max(1, Math.floor(src.length / 4));
  const show = src.filter((_, k) => k % step === 0).slice(0, 4);
  return h(`button.dcard.n${show.length}`, { onclick: () => go({ view: 'day', key: d.key }, true) },
    show.map(i => h('img', { src: thumbUrl(i, show.length === 1 ? 480 : 320, editV(i), true), loading: 'lazy' })),
    h('div.t', h('b', fmt.relDay(d.date)), h('span', fmt.items(d.items.length))));
}
function memCard(m) {
  const c = m.cover;
  return h('button.memcard', { onclick: () => playMemory(m), dataset: m.trip && m.center ? { geo: geoKey(m.center) } : {} },
    h('img', { src: thumbUrl(c, 720, editV(c)), loading: 'lazy' }),
    h('div.t', h('b', m.title), h('span', m.subtitle)),
    h('div.play.glass.dim', icon('play')));
}
function pinTile(k) {
  const p = pinnedEntry(k);
  if (!p) return null;
  const items = p.items();
  if (p.locked && S.data.settings.hello && !R.unlocked) {
    return h('button.pin.locked', { onclick: () => go(p.route, true) }, h('div.lockface', icon('lock')), h('div.t', icon(p.ic), p.label));
  }
  if (k === 'map') {
    const cover = items.at(-1);
    return h('button.pin.map-pin', { onclick: () => go(p.route, true) }, cover ? h('img', { src: thumbUrl(cover, 480, editV(cover), true), style: { filter: 'saturate(.6) brightness(1.05)' } }) : null, icon('location', 'big'), h('div.t', icon('map'), 'Mapa'));
  }
  const cover = items.at(-1);
  if (!cover) return h('button.pin.none', { onclick: () => go(p.route, true) }, icon(p.ic), h('div.t', p.label));
  return h('button.pin', { onclick: () => go(p.route, true) }, h('img', { src: thumbUrl(cover, 480, editV(cover), true), loading: 'lazy' }), h('div.t', icon(p.ic), p.label));
}
function albumCard(a) {
  const items = albumItems(a);
  const c = items.at(-1);
  return h('button.acard', { onclick: () => go({ view: 'album', id: a.id }, true), oncontextmenu: e => navContext(e, { view: 'album', id: a.id }) },
    h('div.cv', c ? h('img', { src: thumbUrl(c, 480, editV(c), true), loading: 'lazy' }) : icon('album')), h('b', a.name), h('span', nf.format(items.length)));
}
function listRow(ic, label, val, onclick) {
  return h('button.row', { onclick }, icon(ic), h('span.lbl', label), val != null ? h('span.val', val) : null, icon('fwd', 'chev'));
}

function collectionsView(restoreScroll) {
  const s = scroller();
  const page = h('div.page');
  page.append(h('div.page-head', h('div', h('h1', 'Coleções'))));
  const rd = recentDays(12);
  if (rd.length) page.append(sec('Dias Recentes', () => go({ view: 'days' }, true), h('div.hscroll', rd.map(dayCard))));
  const mem = memories();
  if (mem.length) page.append(sec('Memórias', () => go({ view: 'memories' }, true), h('div.hscroll', mem.slice(0, 12).map(memCard))));
  page.append(h('section.sec', h('div.sec-head', h('h2', 'Fixados'), h('button.act', { onclick: editPins }, 'Editar')), h('div.pins', S.data.pinned.map(pinTile))));
  page.append(h('section.sec', h('div.sec-head', h('h2', 'Álbuns'), h('button.act', { onclick: () => newAlbum() }, 'Novo Álbum')),
    h('div.hscroll', S.data.albums.slice().reverse().map(albumCard), h('button.acard.new', { onclick: () => newAlbum() }, h('div.cv', icon('plus')), h('b', 'Novo Álbum'), h('span', ' ')))));
  const tr = trips();
  if (tr.length) page.append(sec('Viagens', () => go({ view: 'trips' }, true), h('div.hscroll', tr.slice(0, 10).map(tripCard))));
  const fe = featured(16);
  if (fe.length) page.append(sec('Em Destaque', () => go({ view: 'set', key: 'featured' }, true), h('div.hscroll', fe.slice(0, 10).map(i => h('button.memcard', { style: { width: '200px' }, onclick: () => openViewer(fe, fe.indexOf(i), {}) }, h('img', { src: thumbUrl(i, 480, editV(i), true), loading: 'lazy' }))))));
  const types = MEDIA_TYPES.map(k => [k, SETS[k].get().length]).filter(([, n]) => n);
  page.append(h('div.lists',
    types.length ? h('section.sec', h('div.sec-head', h('h2', 'Tipos de Mídia')), h('div.list', types.map(([k, n]) => listRow(SETS[k].icon, SETS[k].title, nf.format(n), () => go({ view: 'set', key: k }, true))))) : null,
    h('section.sec', h('div.sec-head', h('h2', 'Utilidades')), h('div.list', visibleUtilities().map(k => listRow(SETS[k].icon, SETS[k].title, SETS[k].locked ? null : nf.format(SETS[k].get().length), () => go({ view: 'set', key: k }, true))),
      listRow('map', 'Mapa', nf.format(SETS.located.get().length), () => go({ view: 'map' }, true))))));
  s.append(page);
  setTitle('Coleções', '');
  const upd = () => { if (R.tbFade !== !(s.scrollTop > 50)) tbFade(!(s.scrollTop > 50)); };
  s.addEventListener('scroll', upd, { passive: true });
  upd();
  if (restoreScroll != null) s.scrollTop = restoreScroll;
  // nomes de lugares das viagens chegam aos poucos
  resolvePlaces(tr.slice(0, 10).map(t => t.center));
}

// Nomes de lugares: em vez de redesenhar a tela inteira a cada resposta do Nominatim (as faixas
// voltavam ao início e as seções piscavam), troca só o título dos cartões daquele lugar.
const geoKey = c => `${c.lat.toFixed(1)},${c.lon.toFixed(1)}`;
function resolvePlaces(centers) {
  const v = view.firstElementChild;
  for (const c of centers) {
    if (!c || placeLabel(c)) continue;
    resolvePlace(c).then(n => {
      if (!n || view.firstElementChild !== v) return;
      view.querySelectorAll(`[data-geo="${geoKey(c)}"] .t b`).forEach(b => (b.textContent = n));
    });
  }
}

function tripCard(t) {
  const c = keyPhoto(t.items);
  return h('button.memcard', { style: { width: '300px', aspectRatio: '4 / 3' }, dataset: { geo: geoKey(t.center) }, onclick: () => go({ view: 'trip', id: t.id }, true) },
    h('img', { src: thumbUrl(c, 720, editV(c)), loading: 'lazy' }),
    h('div.t', h('b', placeLabel(t.center) || 'Viagem'), h('span', rangeLabel(t.date, t.end))));
}

function editPins() {
  const all = ['favorites', 'videos', 'screenshots', 'map', 'deleted', 'hidden', 'recents', 'featured', 'panoramas', 'selfies', 'imports', 'duplicates', ...S.data.albums.map(a => 'album:' + a.id)];
  sheet((el, close) => {
    const grp = h('div.grp.picker-list', all.map(k => {
      const p = pinnedEntry(k);
      if (!p) return null;
      return h('div.row', icon(p.ic), h('span.lbl', p.label), switchEl(S.data.pinned.includes(k), v => {
        S.data.pinned = v ? [...S.data.pinned, k] : S.data.pinned.filter(x => x !== k);
        save();
      }));
    }));
    el.append(h('h2', 'Fixados'), h('p.sub', 'Escolha o que aparece no topo de Coleções.'), grp, h('div.foot', h('button.gbtn.accent', { onclick: close }, 'OK')));
  });
}

function pageWith(title, sub, body) {
  const s = scroller();
  s.append(h('div.page', h('div.page-head', h('div', h('h1', title), sub ? h('p', sub) : null)), body));
  setTitle(title, '');
  const upd = () => { if (R.tbFade !== !(s.scrollTop > 50)) tbFade(!(s.scrollTop > 50)); };
  s.addEventListener('scroll', upd, { passive: true });
  upd();
  return s;
}
const wrapGrid = (min, kids) => h('div', { style: { display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: '16px' } }, kids);

function memoriesView() {
  const mem = memories();
  if (!mem.length) return view.append(emptyState('memories', 'Nenhuma Memória Ainda', 'As memórias aparecem quando houver fotos suficientes de um dia, viagem ou mês.'));
  pageWith('Memórias', plural(mem.length, 'memória', 'memórias'), wrapGrid(240, mem.map(m => { const c = memCard(m); c.style.width = 'auto'; return c; })));
  resolvePlaces(mem.filter(m => m.trip).map(m => m.center));
}
function daysView() {
  const ds = recentDays(60);
  pageWith('Dias Recentes', '', wrapGrid(200, ds.map(d => { const c = dayCard(d); c.style.width = 'auto'; return c; })));
}
function tripsView() {
  const tr = trips();
  if (!tr.length) return view.append(emptyState('trips', 'Nenhuma Viagem', 'Viagens aparecem quando há fotos com localização longe de casa.'));
  pageWith('Viagens', plural(tr.length, 'viagem', 'viagens'), wrapGrid(280, tr.map(t => { const c = tripCard(t); c.style.width = 'auto'; return c; })));
  resolvePlaces(tr.map(t => t.center));
}

const searchSub = (res, q) => (res.length ? `${fmt.items(res.length)} para “${q}”` : `Nenhum resultado para “${q}”`);

function searchView() {
  const q = R.route.q || '';
  const sug = suggestions(q);
  const res = search(q);
  const s = scroller();
  const head = h('div.page', { style: { paddingBottom: '0' } },
    h('div.page-head', h('div', h('h1', 'Buscar'), h('p.sub', searchSub(res, q)))),
    sug.length ? h('div.list', { style: { marginBottom: '22px' } }, sug.map(x => listRow(x.icon, x.label, x.sub, () => {
      if (x.go) { searchInput.value = ''; go(x.go); } else { searchInput.value = x.q; R.route.q = x.q; renderView(); }
    }))) : null);
  s.append(head);
  setTitle('Buscar', '');
  if (!res.length) return;
  const host = h('div');
  s.append(host, h('div.grid-foot', h('b', fmt.items(res.length))));
  const g = (R.grid = new VGrid({
    scroller: s, host, items: res, cols: colsFor(s.clientWidth, S.data.settings.zoom), aspect: S.data.settings.aspect, selection: R.sel, selecting: () => R.selecting, onSel,
    onOpen: (it, i, list) => openViewer(list, i, { grid: g, rect: g.tileRect(i) }), onContext: (it, i, e) => tileMenu(it, i, e),
  }));
  g.setAspect(S.data.settings.aspect);
  watchCols(g, host);
  renderChrome();
}

function watchCols(g, host) {
  const ro = new ResizeObserver(() => host.isConnected && host.clientWidth && g.setCols(colsFor(host.clientWidth, S.data.settings.zoom)));
  ro.observe(host);
  R.cleanup.push(() => ro.disconnect());
}

// ============ fundo ambiente (o vidro da barra lateral reflete suas fotos) ============
function ambient() {
  const pick = featured(6).slice(0, 6);
  $('#ambient').replaceChildren(...pick.map(i => h('img', { src: thumbUrl(i, 200, editV(i)) })));
}

// ============ atalhos ============
document.addEventListener('keydown', e => {
  if (document.querySelector('.viewer, .editor, .memory, .sheet, .alert, .menu')) return;
  const typing = e.target.matches?.('input, textarea');
  if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openSearch(); return; }
  // Ctrl+= / Ctrl+- nunca chegam ao zoom da WebView (nem com o foco no campo de busca)
  const zoomKey = e.ctrlKey && (e.key === '=' || e.key === '+' || e.key === '-');
  if (zoomKey) e.preventDefault();
  if (typing) return;
  if (zoomKey) zoom(e.key === '-' ? 1 : -1);
  else if (e.ctrlKey && (e.key === 'a' || e.key === 'A') && R.grid) { e.preventDefault(); if (!R.selecting) startSelect(); selectAll(false); }
  else if (e.ctrlKey && e.altKey && (e.key === 's' || e.key === 'S')) toggleSidebar();
  else if (e.key === 'Escape' && R.selecting) endSelect();
  else if ((e.key === 'Delete' || e.key === 'Backspace') && R.sel.size) deleteItems([...R.sel]);
  else if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowLeft')) goBack();
  else if (e.key === '1' && e.ctrlKey) go({ view: 'library', mode: 'years' });
  else if (e.key === '2' && e.ctrlKey) go({ view: 'library', mode: 'months' });
  else if (e.key === '3' && e.ctrlKey) go({ view: 'library', mode: 'all' });
});
window.addEventListener('mouseup', e => { if (e.button === 3) goBack(); });

// ============ início ============
let refreshing = false;
onChange(() => {
  if (refreshing) return;
  refreshing = true;
  requestAnimationFrame(() => {
    refreshing = false;
    renderNav();
    const r = R.route;
    if (document.querySelector('.viewer')) return;
    const scrollTop = view.querySelector('.scroller')?.scrollTop;
    if (R.grid && ['library', 'set', 'album', 'day', 'folder', 'trip', 'search'].includes(r.view) && r.mode !== 'years' && r.mode !== 'months') {
      const items = currentItems();
      if (items) {
        R.grid.setItems(items);
        pruneSelection(items);
        const f = view.querySelector('.grid-foot b');
        if (f) f.textContent = r.view === 'search' ? fmt.items(items.length) : countSub(items);
        // cabeçalho e barra superior acompanham a contagem (antes só o rodapé mudava)
        if (r.view === 'search') {
          const p = view.querySelector('.page-head p.sub');
          if (p) p.textContent = searchSub(items, r.q || '');
        } else if (R.head?.sub) {
          const sub = R.head.sub(items);
          const p = view.querySelector('.grid-head p.sub');
          if (p) p.textContent = sub;
          setTitle(R.head.title, sub);
        }
        if (!items.length) renderView();
        return;
      }
    }
    // a busca sem resultados (sem grade) também se refaz: o termo pode voltar a casar depois de recuperar
    if (r.view !== 'map') renderView(scrollTop);
  });
});

/** tira da seleção o que saiu da grade (ocultado, apagado, removido do álbum): senão a barra
 *  contava itens invisíveis e o próximo Apagar levava junto o que a pessoa não via */
function pruneSelection(items) {
  if (!R.sel.size) return;
  const ids = new Set(items.map(i => i.id));
  let changed = false;
  for (const id of R.sel) if (!ids.has(id)) { R.sel.delete(id); changed = true; }
  if (!changed) return;
  R.grid.syncSelection();
  const bar = bottom.querySelector('.selbar');
  if (bar) updateSelBar(bar);
}

function currentItems() {
  const r = R.route;
  if (r.view === 'library') return library();
  if (r.view === 'search') return search(r.q || '');
  if (r.view === 'set') return SETS[r.key].locked && S.data.settings.hello && !R.unlocked ? null : SETS[r.key].get();
  if (r.view === 'album') { const a = albumById(r.id); return a ? albumItems(a) : null; }
  if (r.view === 'day') return library().filter(i => i.day === r.key);
  if (r.view === 'folder') return folderItems(r.path);
  if (r.view === 'trip') return trips().find(t => t.id === r.id)?.items;
  return null;
}

export const app = { go, renderView, deleteItems, exportItems, pickAlbum, setWallpaper, rescan, R };

async function boot() {
  wireWindow();
  await loadData();
  applyTheme();
  if (!compact() && S.data.settings.sideOff) document.body.classList.add('side-off');
  if (!S.data.folders.length) {
    S.data.folders = await api.defaultFolders();
    save();
  }
  const cached = await api.cachedIndex();
  setItems(cached);
  renderNav();
  renderView();
  ambient();
  // a janela aparece já; a foto aberta pelo Explorador entra logo depois (ler a pasta pode levar segundos)
  api.win?.show();
  // ouve a 2ª instância antes de pegar o arquivo da abertura, para nenhum pedido se perder no meio
  if (native) window.__TAURI__.event.listen('open-file', e => openFromPath(e.payload));
  const launch = await api.launchFile();
  if (launch) await openFromPath(launch);
  await rescan(!cached.length);
  ambient();

  if (native) {
    window.__TAURI__.event.listen('tauri://drag-drop', e => importPaths(e.payload.paths || []));
    window.addEventListener('focus', () => { if (Date.now() - lastScan > 120e3) rescan(false); });
  }
}
boot();
