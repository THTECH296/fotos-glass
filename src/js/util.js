// Utilidades: DOM, ícones no estilo SF Symbols e formatação em pt-BR.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div.a.b', {onclick}, ...filhos) */
export function h(tag, props, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    kids.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

// ---------- ícones (grade 24, traço 1.8) ----------
const P = {
  photos: '<path d="M12 4.2a3 3 0 0 1 3 3v2.4M12 4.2a3 3 0 0 0-3 3v2.4M19.8 12a3 3 0 0 1-3 3h-2.4M19.8 12a3 3 0 0 0-3-3h-2.4M12 19.8a3 3 0 0 1-3-3v-2.4M12 19.8a3 3 0 0 0 3-3v-2.4M4.2 12a3 3 0 0 1 3-3h2.4M4.2 12a3 3 0 0 0 3 3h2.4"/>',
  library: '<rect x="3" y="6.5" width="14.5" height="13" rx="2.6"/><path d="M6.5 4h11a3 3 0 0 1 3 3v9.5"/><path d="m3.4 17 4.1-4.2 3.2 3.1 2.1-2 4.4 4.4"/><circle cx="13" cy="10.3" r="1.3"/>',
  collections: '<rect x="3.5" y="3.5" width="7.2" height="7.2" rx="2"/><rect x="13.3" y="3.5" width="7.2" height="7.2" rx="2"/><rect x="3.5" y="13.3" width="7.2" height="7.2" rx="2"/><rect x="13.3" y="13.3" width="7.2" height="7.2" rx="2"/>',
  search: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 4.9 4.9"/>',
  heart: '<path d="M12 20s-7.8-4.6-7.8-10.3A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.8 2.5C19.8 15.4 12 20 12 20Z"/>',
  heartFill: '<path fill="currentColor" stroke="none" d="M12 20.4s-8.4-4.9-8.4-10.9A4.7 4.7 0 0 1 12 6.6a4.7 4.7 0 0 1 8.4 2.9c0 6-8.4 10.9-8.4 10.9Z"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="2.6"/><path d="m16 10.5 4.6-2.7v8.4L16 13.5"/>',
  screenshot: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>',
  map: '<path d="m9 4.5-5 2v13l5-2 6 2 5-2v-13l-5 2-6-2Z"/><path d="M9 4.5v13M15 6.5v13"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.8c0-.6.5-1 1-1h3c.6 0 1 .4 1 1v1.7M6.5 6.5l.9 12.2c.1 1 .9 1.8 1.9 1.8h5.4c1 0 1.8-.8 1.9-1.8l.9-12.2M10 10.5v6M14 10.5v6"/>',
  hidden: '<path d="M3 12s3.3-6 9-6c1.6 0 3 .5 4.2 1.2M21 12s-1 1.8-3 3.5M14.1 14.1A3 3 0 0 1 9.9 9.9"/><path d="M8 17.2c1.2.5 2.5.8 4 .8 5.7 0 9-6 9-6M4 20 20 4"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>',
  memories: '<path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9 18 18M6 18l2.1-2.1M15.9 8.1 18 6"/><circle cx="12" cy="12" r="2.6"/>',
  sparkles: '<path d="M10 3.5c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6Z"/><path d="M18 14.5c.3 1.7 1.1 2.5 2.8 2.8-1.7.3-2.5 1.1-2.8 2.8-.3-1.7-1.1-2.5-2.8-2.8 1.7-.3 2.5-1.1 2.8-2.8Z"/>',
  trips: '<path d="M10.2 13.8 4 12.3l1.3-1.4 6.3.4 4.2-4.6c.9-1 2.3-1.3 2.9-.7s.3 2-.7 2.9l-4.6 4.2.4 6.3-1.4 1.3-1.5-6.2"/><path d="m7.4 15.3-1.8 3 3-1.8"/>',
  star: '<path d="m12 3.8 2.5 5.2 5.6.7-4.1 3.9 1 5.6L12 16.5l-5 2.7 1-5.6-4.1-3.9 5.6-.7L12 3.8Z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.8"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"/>',
  folderPlus: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"/><path d="M12 11v5M9.5 13.5h5"/>',
  album: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m4.5 16.5 4.3-4.3 3.4 3.3 2.3-2.2 5 5"/><circle cx="15" cy="9" r="1.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  back: '<path d="M14.5 5 8 12l6.5 7"/>',
  fwd: '<path d="M9.5 5 16 12l-6.5 7"/>',
  down: '<path d="m6 9.5 6 6 6-6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  more: '<circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor"/>',
  edit: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  share: '<path d="M12 3.5v11M8 7.5l4-4 4 4"/><path d="M8.5 10.5H7a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5.5a2 2 0 0 0-2-2h-1.5"/>',
  check: '<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>',
  selectCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.3 12.3 2.6 2.6 4.9-5.3"/>',
  checkCircle: '<circle cx="12" cy="12" r="9" fill="currentColor" stroke="none"/><path d="m8 12.3 2.7 2.7 5.4-5.6" stroke="#fff" stroke-width="2"/>',
  sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15M5.6 8h1.6M5.6 11h1.6"/>',
  rotate: '<path d="M5 9.5A7.5 7.5 0 1 1 4.5 14"/><path d="M4.5 4.8v4.9h4.9"/>',
  flip: '<path d="M12 3.5v17"/><path d="M9 7 4 17h5V7ZM15 7l5 10h-5V7Z"/>',
  crop: '<path d="M7 3.5v12.5a1 1 0 0 0 1 1h12.5"/><path d="M3.5 7H16a1 1 0 0 1 1 1v12.5"/>',
  wand: '<path d="m4 20 10.5-10.5M13 8l3 3"/><path d="M16.5 3.5v3M15 5h3M20 9v2.6M18.7 10.3h2.6M9.5 3.5v2M8.5 4.5h2"/>',
  play: '<path fill="currentColor" stroke="none" d="M8 5.6v12.8c0 .8.9 1.3 1.6.8l9.6-6.4c.6-.4.6-1.2 0-1.6L9.6 4.8C8.9 4.3 8 4.8 8 5.6Z"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.3" fill="currentColor" stroke="none"/><rect x="13.5" y="5" width="4" height="14" rx="1.3" fill="currentColor" stroke="none"/>',
  speaker: '<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="M15 9a4.5 4.5 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3l4.5-4v13L7 14.5H4z"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/>',
  panorama: '<path d="M3 6.5c6 1.6 12 1.6 18 0v11c-6-1.6-12-1.6-18 0z"/>',
  gif: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 10h-2a1.5 1.5 0 0 0-1.5 1.5v1A1.5 1.5 0 0 0 8 14h1.5v-1.6M12.5 10v4M15.5 14v-4h2.3M15.5 12h1.8"/>',
  raw: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M6.5 14.5v-5h1.8a1.4 1.4 0 0 1 0 2.8H6.5m2.2 0 1.2 2.2M11 14.5l1.6-5 1.6 5M11.5 13h2.2M15.2 9.5l.9 5 1.2-3.5 1.2 3.5.9-5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  wallpaper: '<rect x="3" y="4" width="18" height="12.5" rx="2.2"/><path d="M9 20.5h6M12 16.5v4"/><path d="m6 14 3.5-3.5 2.5 2.4 1.6-1.6L17.5 15"/>',
  explorer: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5Z"/><path d="m12.5 13.5 3 0M14 12v3"/>',
  restore: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  contrast: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
  brilliance: '<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5v15M12 8l5 0M12 12h7.5M12 16h5"/>',
  highlights: '<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5a7.5 7.5 0 0 1 0 15" fill="currentColor"/><path d="M8 9h1M8 12h1M8 15h1"/>',
  shadows: '<circle cx="12" cy="12" r="7.5"/><path d="M12 4.5a7.5 7.5 0 0 0 0 15" fill="currentColor"/>',
  blackpoint: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
  drop: '<path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5Z"/>',
  vibrance: '<path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5Z"/><path d="M8.5 15a3.6 3.6 0 0 0 3.5 3"/>',
  warmth: '<path d="M10 14.5V5.5a2 2 0 0 1 4 0v9a3.6 3.6 0 1 1-4 0Z"/><path d="M12 9v6.5"/>',
  tint: '<circle cx="9.5" cy="9.5" r="5"/><circle cx="14.5" cy="14.5" r="5"/>',
  sharp: '<path d="M12 3.5 20 18H4z"/>',
  vignette: '<rect x="3.5" y="5" width="17" height="14" rx="3"/><ellipse cx="12" cy="12" rx="5" ry="3.6"/>',
  exposure: '<circle cx="12" cy="12" r="8"/><path d="M8 9.5h3M9.5 8v3M13 14.5h3"/>',
  filters: '<circle cx="12" cy="9" r="4.8"/><circle cx="8.6" cy="14.6" r="4.8"/><circle cx="15.4" cy="14.6" r="4.8"/>',
  aspect: '<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M7 9.5v-1h2M17 14.5v1h-2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5"/><circle cx="12" cy="12" r="6.4"/>',
  pin: '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6"/>',
  slideshow: '<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="m10.2 8.6 4.4 2.4-4.4 2.4z" fill="currentColor"/><path d="M8 20h8"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/>',
  open: '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  people: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.6" cy="9.4" r="2.6"/><path d="M15.5 14.2A4.6 4.6 0 0 1 21 18.5"/>',
  import: '<path d="M12 4v10M8 10l4 4 4-4"/><path d="M4.5 15v2.5A2.5 2.5 0 0 0 7 20h10a2.5 2.5 0 0 0 2.5-2.5V15"/>',
  zoomIn: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 4.9 4.9M8 10.6h5.2M10.6 8v5.2"/>',
  zoomOut: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 4.9 4.9M8 10.6h5.2"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>',
  sort: '<path d="M7 4.5v15M3.8 16.3 7 19.5l3.2-3.2M17 19.5v-15M13.8 7.7 17 4.5l3.2 3.2"/>',
  location: '<path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  camera: '<path d="M4 8.5a2 2 0 0 1 2-2h2l1.5-2h5L16 6.5h2a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.5" r="3.4"/>',
  caption: '<path d="M5 6.5h14M5 10.5h14M5 14.5h8"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>',
  undo: '<path d="M8.5 5 4 9.5 8.5 14"/><path d="M4.5 9.5H14a6 6 0 0 1 0 12h-2"/>',
};

export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = P[name] || P.photos;
  return s;
}

// ---------- formatação ----------
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MESES_C = ['jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.', 'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.'];
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const DIAS_C = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'];
export { MESES };

export const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const pad = n => String(n).padStart(2, '0');
export const nf = new Intl.NumberFormat('pt-BR');

export function parseLocal(iso) {
  const [d, t = '00:00:00'] = iso.split('T');
  const [y, m, dd] = d.split('-').map(Number);
  const [hh, mi, ss] = t.split(':').map(Number);
  return new Date(y, m - 1, dd, hh, mi, ss || 0);
}

export const fmt = {
  month: d => cap(MESES[d.getMonth()]),
  monthYear: d => `${cap(MESES[d.getMonth()])} de ${d.getFullYear()}`,
  monthShortYear: d => `${cap(MESES_C[d.getMonth()])} de ${d.getFullYear()}`,
  day: d => `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`,
  dayShort: d => `${d.getDate()} de ${MESES_C[d.getMonth()]} de ${d.getFullYear()}`,
  dayNoYear: d => `${d.getDate()} de ${MESES[d.getMonth()]}`,
  weekday: d => cap(DIAS[d.getDay()]),
  weekdayShort: d => cap(DIAS_C[d.getDay()]),
  time: d => `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  relDay(d) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    const diff = Math.round((today - x) / 864e5);
    if (diff === 0) return 'Hoje';
    if (diff === 1) return 'Ontem';
    if (diff < 7) return cap(DIAS[d.getDay()]);
    return d.getFullYear() === today.getFullYear() ? `${fmt.weekdayShort(d)}, ${fmt.dayNoYear(d)}` : fmt.dayShort(d);
  },
  dur(s) {
    s = Math.round(s || 0);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
  },
  bytes(b) {
    if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
    return `${(b / 1024 ** 3).toFixed(2).replace('.', ',')} GB`;
  },
  count(photos, videos) {
    const p = photos ? `${nf.format(photos)} ${photos === 1 ? 'Foto' : 'Fotos'}` : '';
    const v = videos ? `${nf.format(videos)} ${videos === 1 ? 'Vídeo' : 'Vídeos'}` : '';
    return [p, v].filter(Boolean).join(', ') || 'Nenhum item';
  },
  items: n => `${nf.format(n)} ${n === 1 ? 'item' : 'itens'}`,
};

/** "1 ano" / "3 anos" */
export const plural = (n, um, varios) => `${nf.format(n)} ${n === 1 ? um : varios}`;

export const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** gerador pseudoaleatório determinístico (para "Em destaque" mudar 1× por dia) */
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function haversine(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
