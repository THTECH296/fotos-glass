// Estado da biblioteca e coleções derivadas (dias, meses, anos, memórias, viagens, tipos de mídia…).

import { api } from './api.js';
import { parseLocal, norm, fmt, MESES, rng, haversine, debounce } from './util.js';

const DEFAULT = {
  folders: [],
  favorites: {},
  hidden: {},
  deleted: {},
  albums: [],
  pinned: ['favorites', 'videos', 'screenshots', 'map', 'deleted'],
  edits: {},
  captions: {},
  places: {},
  settings: { theme: 'auto', hello: true, places: true, aspect: false, zoom: 4 },
};

export const S = {
  all: [],
  byId: new Map(),
  data: structuredClone(DEFAULT),
  listeners: new Set(),
  version: 0,
};

// Gravação do estado (apagados, favoritos, álbuns…). Uma de cada vez, na ordem; a última sempre vence.
let saving = Promise.resolve();
let failedOnce = false;
function writeNow() {
  const snapshot = JSON.parse(JSON.stringify(S.data));
  saving = saving.then(() => api.saveState(snapshot)).then(
    () => { failedOnce = false; },
    err => {
      console.error('falha ao salvar', err);
      if (!failedOnce) {
        failedOnce = true;
        import('./ui.js').then(m => m.toast('Não foi possível salvar as mudanças. Tentando de novo…', 'info'));
      }
      setTimeout(writeNow, 1500);
    },
  );
  return saving;
}
const persist = debounce(writeNow, 350);
let unsaved = false;
/** `now`: grava na hora (exclusões e recuperações não podem se perder se a janela fechar logo depois). */
export function save(now = false) {
  S.version++;
  cache.clear();
  unsaved = true;
  if (now) writeNow().finally(() => (unsaved = false));
  else persist();
  emit();
}
/** Espera a última gravação terminar (usado antes de fechar a janela). */
export async function flushSave() {
  if (unsaved) await writeNow();
  await saving.catch(() => {});
}
export function emit() {
  for (const fn of S.listeners) fn();
}
export const onChange = fn => S.listeners.add(fn);

export async function loadData() {
  const d = await api.loadState();
  if (d && typeof d === 'object') {
    S.data = { ...structuredClone(DEFAULT), ...d, settings: { ...DEFAULT.settings, ...(d.settings || {}) } };
  }
  return S.data;
}

const SHOT_RE = /(screenshot|captura de tela|captura|screen ?shot|printscreen|\bprint\b|snip|recorte)/i;
const RAW = new Set(['DNG', 'CR2', 'CR3', 'CRW', 'NEF', 'NRW', 'ARW', 'SRF', 'SR2', 'RAF', 'ORF', 'RW2', 'RWL', 'PEF', 'PTX', 'SRW', 'X3F', '3FR', 'FFF', 'IIQ', 'MEF', 'MOS', 'ERF', 'KDC', 'DCR', 'DCS', 'DRF', 'K25', 'MRW', 'MDC', 'RAW', 'RWZ', 'CAP', 'EIP', 'BAY', 'ARI', 'ORI', 'PXN']);

export function setItems(items) {
  derive(items);
  items.sort((a, b) => a.t - b.t || (a.name < b.name ? -1 : 1));
  S.all = items;
  S.byId = new Map(items.map(i => [i.id, i]));
  cache.clear();
  emit();
}

/** campos calculados (data, mês, tipo…) a partir do que vem do Rust */
export function derive(items) {
  for (const it of items) {
    const d = parseLocal(it.date);
    it.t = d.getTime();
    it.day = it.date.slice(0, 10);
    it.month = it.date.slice(0, 7);
    it.year = d.getFullYear();
    it.shot = !it.video && (SHOT_RE.test(it.name) || /screenshots|capturas/i.test(it.dir));
    it.pano = !it.video && it.w > 0 && it.w / it.h >= 2.6;
    it.gif = it.fmt === 'GIF';
    it.raw = RAW.has(it.fmt);
    it.selfie = /front|frontal|selfie/i.test(it.lens || '');
    it._hay = null;
  }
  return items;
}

// ---------- filtros ----------
const cache = new Map();
function memo(key, fn) {
  const k = key;
  if (!cache.has(k)) cache.set(k, fn());
  return cache.get(k);
}

export const isFav = it => !!S.data.favorites[it.id];
export const isHidden = it => !!S.data.hidden[it.id];
export const isDeleted = it => !!S.data.deleted[it.id];
export const editV = it => S.data.edits[it.id]?.v;

/** biblioteca visível (sem ocultos e apagados) */
export const library = () => memo('lib', () => S.all.filter(i => !S.data.deleted[i.id] && !S.data.hidden[i.id]));
const live = () => S.all.filter(i => !S.data.deleted[i.id]);

export const SETS = {
  favorites: { title: 'Favoritos', icon: 'heart', get: () => library().filter(isFav) },
  videos: { title: 'Vídeos', icon: 'video', get: () => library().filter(i => i.video) },
  screenshots: { title: 'Capturas de Tela', icon: 'screenshot', get: () => library().filter(i => i.shot) },
  panoramas: { title: 'Panoramas', icon: 'panorama', get: () => library().filter(i => i.pano) },
  selfies: { title: 'Selfies', icon: 'people', get: () => library().filter(i => i.selfie) },
  gifs: { title: 'Animados', icon: 'gif', get: () => library().filter(i => i.gif) },
  raw: { title: 'RAW', icon: 'raw', get: () => library().filter(i => i.raw) },
  located: { title: 'Mapa', icon: 'map', get: () => library().filter(i => i.lat != null) },
  hidden: { title: 'Ocultos', icon: 'hidden', get: () => live().filter(isHidden), locked: true },
  deleted: { title: 'Apagados Recentemente', icon: 'trash', get: () => S.all.filter(isDeleted).sort((a, b) => S.data.deleted[b.id] - S.data.deleted[a.id]), locked: true },
  duplicates: { title: 'Duplicados', icon: 'duplicate', get: () => duplicates().flat() },
  imports: { title: 'Importações', icon: 'import', get: () => library().filter(i => /\\Importados\\/i.test(i.path)) },
  featured: { title: 'Em Destaque', icon: 'star', get: () => featured(60) },
  recents: { title: 'Adicionados Recentemente', icon: 'clock', get: () => [...library()].sort((a, b) => b.mtime - a.mtime).slice(0, 300) },
};

export const MEDIA_TYPES = ['videos', 'selfies', 'panoramas', 'screenshots', 'gifs', 'raw'];
export const UTILITIES = ['imports', 'duplicates', 'hidden', 'deleted'];

export function setItemsFor(key) {
  const s = SETS[key];
  return s ? s.get() : [];
}

// ---------- agrupamentos ----------
function groupBy(list, key) {
  const m = new Map();
  for (const i of list) {
    const k = i[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(i);
  }
  return m;
}

export const months = () => memo('months', () => [...groupBy(library(), 'month')].map(([k, items]) => ({ key: k, items, date: new Date(items[0].t) })));
export const years = () => memo('years', () => [...groupBy(library(), 'year')].map(([k, items]) => ({ key: k, items, date: new Date(items[0].t) })));
export const days = () => memo('days', () => [...groupBy(library(), 'day')].map(([k, items]) => ({ key: k, items, date: new Date(items[0].t) })));

export const recentDays = (n = 14) => days().slice(-n).reverse();

/** escolhe a foto de capa: favorita > não captura > do meio */
export function keyPhoto(items) {
  const mid = items[Math.floor(items.length / 2)];
  return items.find(i => isFav(i) && !i.video) || (mid && !mid.shot && !mid.video ? mid : null) || items.find(i => !i.shot && !i.video) || items[0];
}

export function featured(n = 24) {
  return memo('featured' + n, () => {
    const today = new Date();
    const r = rng(today.getFullYear() * 400 + today.getMonth() * 32 + today.getDate());
    const pool = library().filter(i => !i.shot && !i.video && !i.gif);
    const favs = pool.filter(isFav);
    const out = new Set();
    while (out.size < Math.min(n, pool.length)) {
      const src = favs.length && r() < 0.35 ? favs : pool;
      out.add(src[Math.floor(r() * src.length)]);
    }
    return [...out].sort((a, b) => a.t - b.t);
  });
}

export function duplicates() {
  return memo('dups', () => {
    const m = new Map();
    for (const i of live()) {
      if (!i.size) continue;
      const k = `${i.size}|${i.w}x${i.h}|${i.date.slice(0, 16)}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(i);
    }
    return [...m.values()].filter(g => g.length > 1);
  });
}

export const albumById = id => S.data.albums.find(a => a.id === id);
export const albumItems = a => a.items.map(id => S.byId.get(id)).filter(i => i && !isDeleted(i) && !isHidden(i));

// ---------- viagens e memórias ----------
function home() {
  const cells = new Map();
  for (const i of library()) {
    if (i.lat == null) continue;
    const k = `${Math.round(i.lat * 2) / 2},${Math.round(i.lon * 2) / 2}`;
    cells.set(k, (cells.get(k) || 0) + 1);
  }
  const best = [...cells].sort((a, b) => b[1] - a[1])[0];
  if (!best) return null;
  const [lat, lon] = best[0].split(',').map(Number);
  return { lat, lon };
}

export const trips = () =>
  memo('trips', () => {
    const h = home();
    if (!h) return [];
    const away = library().filter(i => i.lat != null && haversine(h, i) > 120);
    const out = [];
    let cur = null;
    for (const i of away) {
      if (cur && i.t - cur.last <= 2.2 * 864e5) {
        cur.items.push(i);
        cur.last = i.t;
      } else {
        if (cur) out.push(cur);
        cur = { items: [i], last: i.t };
      }
    }
    if (cur) out.push(cur);
    return out
      .filter(t => t.items.length >= 6)
      .map(t => {
        // inclui as fotos sem GPS tiradas no mesmo período
        const a = t.items[0].t - 3600e3, b = t.last + 3600e3;
        const items = library().filter(i => i.t >= a && i.t <= b);
        const c = center(t.items);
        return { id: 'trip-' + t.items[0].id, kind: 'trip', items, center: c, date: new Date(items[0].t), end: new Date(items.at(-1).t) };
      })
      .reverse();
  });

function center(items) {
  const g = items.filter(i => i.lat != null);
  return { lat: g.reduce((s, i) => s + i.lat, 0) / g.length, lon: g.reduce((s, i) => s + i.lon, 0) / g.length };
}

function pickSpread(items, n) {
  const good = items.filter(i => !i.shot && !i.gif);
  const src = good.length >= 3 ? good : items;
  if (src.length <= n) return src;
  const favs = src.filter(isFav);
  const step = src.length / (n - Math.min(favs.length, n / 3));
  const out = new Set(favs.slice(0, Math.floor(n / 3)));
  for (let x = 0; out.size < n && x < src.length; x += step) out.add(src[Math.floor(x)]);
  return [...out].sort((a, b) => a.t - b.t);
}

export function placeLabel(c) {
  if (!c) return '';
  const k = `${c.lat.toFixed(1)},${c.lon.toFixed(1)}`;
  return S.data.places[k] || '';
}

export const memories = () =>
  memo('memories', () => {
    const out = [];
    const now = new Date();
    const lib = library();
    // Neste dia
    const md = (now.getMonth() + 1) * 100 + now.getDate();
    const onDay = lib.filter(i => {
      const d = new Date(i.t);
      const x = (d.getMonth() + 1) * 100 + d.getDate();
      return d.getFullYear() < now.getFullYear() && Math.abs(x - md) <= 3 && !i.shot;
    });
    if (onDay.length >= 4) out.push({ id: 'onthisday', title: 'Neste Dia', subtitle: fmt.dayNoYear(now), items: pickSpread(onDay, 30), date: now });
    // viagens
    for (const t of trips().slice(0, 8)) {
      const place = placeLabel(t.center);
      out.push({ id: t.id, title: place || 'Viagem', subtitle: rangeLabel(t.date, t.end), items: pickSpread(t.items, 36), date: t.date, center: t.center, trip: true });
    }
    // meses movimentados
    for (const m of months().slice(-36).reverse()) {
      const good = m.items.filter(i => !i.shot);
      if (good.length >= 25) out.push({ id: 'm-' + m.key, title: `${fmt.month(m.date)} de ${m.date.getFullYear()}`, subtitle: fmt.count(good.filter(i => !i.video).length, good.filter(i => i.video).length), items: pickSpread(good, 32), date: m.date });
      if (out.length > 18) break;
    }
    // melhores do ano
    for (const y of years().slice(-4).reverse()) {
      if (y.items.length >= 60 && y.key < now.getFullYear()) out.push({ id: 'y-' + y.key, title: `Melhores de ${y.key}`, subtitle: fmt.count(y.items.length, 0).replace(/Fotos?/, 'momentos'), items: pickSpread(y.items, 40), date: y.date });
    }
    for (const m of out) m.cover = keyPhoto(m.items);
    return out;
  });

export function rangeLabel(a, b) {
  if (a.getFullYear() !== b.getFullYear()) return `${fmt.monthShortYear(a)} – ${fmt.monthShortYear(b)}`;
  if (a.getMonth() !== b.getMonth()) return `${a.getDate()} de ${MESES[a.getMonth()].slice(0, 3)}. – ${fmt.dayShort(b)}`;
  if (a.getDate() !== b.getDate()) return `${a.getDate()}–${fmt.day(b)}`;
  return fmt.day(a);
}

// ---------- busca ----------
const KIND_WORDS = [
  ['video', i => i.video], ['videos', i => i.video], ['foto', i => !i.video], ['fotos', i => !i.video],
  ['captura', i => i.shot], ['capturas', i => i.shot], ['screenshot', i => i.shot], ['print', i => i.shot],
  ['favorito', isFav], ['favoritos', isFav], ['favorita', isFav], ['favoritas', isFav],
  ['panorama', i => i.pano], ['selfie', i => i.selfie], ['gif', i => i.gif], ['raw', i => i.raw],
  ['editada', i => !!editV(i)], ['editadas', i => !!editV(i)],
];

function hay(i) {
  if (i._hay && i._hayV === S.version) return i._hay;
  const d = new Date(i.t);
  const parts = [i.name, i.dir.split('\\').slice(-2).join(' '), MESES[d.getMonth()], String(d.getFullYear()), i.make, i.model, i.fmt, S.data.captions[i.id], placeLabel(i.lat != null ? i : null)];
  for (const a of S.data.albums) if (a.items.includes(i.id)) parts.push(a.name);
  i._hay = norm(parts.filter(Boolean).join(' '));
  i._hayV = S.version;
  return i._hay;
}

export function search(q) {
  const toks = norm(q).split(/\s+/).filter(Boolean);
  if (!toks.length) return [];
  return library().filter(i =>
    toks.every(t => {
      const kw = KIND_WORDS.find(k => k[0] === t);
      if (kw) return kw[1](i);
      return hay(i).includes(t);
    }),
  );
}

export function suggestions(q) {
  const n = norm(q);
  if (!n) return [];
  const out = [];
  for (const a of S.data.albums) if (norm(a.name).includes(n)) out.push({ icon: 'album', label: a.name, sub: 'Álbum', go: { view: 'album', id: a.id } });
  MESES.forEach((m, k) => norm(m).startsWith(n) && out.push({ icon: 'calendar', label: m[0].toUpperCase() + m.slice(1), sub: 'Mês', q: m }));
  for (const y of years()) if (String(y.key).startsWith(n)) out.push({ icon: 'calendar', label: String(y.key), sub: fmt.items(y.items.length), q: String(y.key) });
  for (const [k, s] of Object.entries(SETS)) if (norm(s.title).includes(n) && !s.locked) out.push({ icon: s.icon, label: s.title, sub: 'Coleção', go: { view: 'set', key: k } });
  const places = new Set(Object.values(S.data.places));
  for (const p of places) if (p && norm(p).includes(n)) out.push({ icon: 'location', label: p, sub: 'Lugar', q: p });
  const cams = new Set(library().map(i => i.model).filter(Boolean));
  for (const c of cams) if (norm(c).includes(n)) out.push({ icon: 'camera', label: c, sub: 'Câmera', q: c });
  return out.slice(0, 8);
}

// ---------- ações ----------
export function toggleFav(ids, value) {
  for (const id of ids) {
    if (value ?? !S.data.favorites[id]) S.data.favorites[id] = 1;
    else delete S.data.favorites[id];
  }
  save();
}
export function setHidden(ids, value) {
  for (const id of ids) value ? (S.data.hidden[id] = 1) : delete S.data.hidden[id];
  save();
}
export function softDelete(ids) {
  const now = Date.now();
  for (const id of ids) S.data.deleted[id] = now;
  save(true);
}
export function recover(ids) {
  for (const id of ids) delete S.data.deleted[id];
  save(true);
}
export function createAlbum(name, ids = []) {
  const a = { id: 'a' + Date.now().toString(36), name: name || 'Novo Álbum', items: [...new Set(ids)], created: Date.now() };
  S.data.albums.push(a);
  save();
  return a;
}
export function addToAlbum(aid, ids) {
  const a = albumById(aid);
  if (!a) return;
  for (const id of ids) if (!a.items.includes(id)) a.items.push(id);
  save();
}
export function removeFromAlbum(aid, ids) {
  const a = albumById(aid);
  if (!a) return;
  a.items = a.items.filter(i => !ids.includes(i));
  save();
}

/** depois de 30 dias, os apagados vão para a Lixeira do Windows */
export async function purgeOld() {
  const lim = Date.now() - 30 * 864e5;
  const old = Object.entries(S.data.deleted).filter(([, t]) => t < lim).map(([id]) => id).filter(id => S.byId.has(id));
  if (!old.length) return;
  try {
    await api.trash(old);
    for (const id of old) dropRefs(id);
    S.all = S.all.filter(i => !old.includes(i.id));
    for (const id of old) S.byId.delete(id);
    save();
  } catch {}
}

export function dropRefs(id) {
  delete S.data.deleted[id];
  delete S.data.favorites[id];
  delete S.data.hidden[id];
  delete S.data.edits[id];
  delete S.data.captions[id];
  for (const a of S.data.albums) a.items = a.items.filter(x => x !== id);
}

// ---------- nomes de lugares (OpenStreetMap, 1 pedido/s, guardado) ----------
const pending = new Map();
let geoBusy = Promise.resolve();
export function resolvePlace(c) {
  if (!c || !S.data.settings.places || !navigator.onLine) return Promise.resolve('');
  const k = `${c.lat.toFixed(1)},${c.lon.toFixed(1)}`;
  if (k in S.data.places) return Promise.resolve(S.data.places[k]);
  if (pending.has(k)) return pending.get(k);
  const p = (geoBusy = geoBusy.then(async () => {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=pt-BR&lat=${c.lat.toFixed(3)}&lon=${c.lon.toFixed(3)}`);
      const j = await r.json();
      const a = j.address || {};
      const name = a.city || a.town || a.village || a.municipality || a.county || a.state || j.name || '';
      S.data.places[k] = name;
      save();
      await new Promise(r => setTimeout(r, 1100));
      return name;
    } catch {
      return '';
    }
  }));
  pending.set(k, p);
  return p;
}
