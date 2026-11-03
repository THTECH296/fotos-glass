// Ponte com o Rust. Fora do app (navegador comum) entra um modo demonstração com fotos de exemplo.

const T = window.__TAURI__;
export const native = !!T;
const invoke = (cmd, args) => T.core.invoke(cmd, args);

export const api = {
  async loadState() {
    if (native) return invoke('load_state');
    try { return JSON.parse(localStorage.getItem('fotos-demo') || 'null'); } catch { return null; }
  },
  saveState(state) {
    if (native) return invoke('save_state', { state });
    try { localStorage.setItem('fotos-demo', JSON.stringify(state)); } catch {}
  },
  defaultFolders: () => (native ? invoke('default_folders') : Promise.resolve(['C:\\Users\\Demo\\Pictures'])),
  cachedIndex: () => (native ? invoke('cached_index') : Promise.resolve(demoItems())),
  scan: folders => (native ? invoke('scan_library', { folders }) : Promise.resolve(demoItems())),
  pickFolder: () => (native ? invoke('pick_folder') : Promise.resolve(null)),
  trash: ids => (native ? invoke('trash_files', { ids }) : Promise.resolve(ids.length)),
  reveal: id => native && invoke('reveal', { id }),
  openDefault: id => native && invoke('open_with_default', { id }),
  /** só pasta que existe (o Rust recusa arquivo, programa ou shell:) */
  openFolder: path => native && invoke('open_folder', { path }),
  /** só https:// */
  openUrl: url => (native ? invoke('open_url', { url }) : window.open(url, '_blank', 'noopener')),
  /** @deprecated o comando open_path saiu (executava qualquer coisa pelo Explorador); use openFolder/openUrl */
  openPath: path => (/^https:\/\//i.test(path) ? api.openUrl(path) : api.openFolder(path)),
  saveRender: (id, data) => (native ? invoke('save_render', { id, data }) : Promise.resolve()),
  /** vídeo editado em binário (Uint8Array), sem passar por base64 */
  saveRenderVideo: (id, ext, bytes) => (native ? T.core.invoke('save_render_raw', bytes, { headers: { 'x-id': id, 'x-ext': ext } }) : Promise.resolve()),
  saveRenderPoster: (id, bytes) => (native ? T.core.invoke('save_render_raw', bytes, { headers: { 'x-id': id, 'x-ext': 'mp4', 'x-capa': '1' } }) : Promise.resolve()),
  deleteRender: id => native && invoke('delete_render', { id }),
  exportItems: items => (native ? invoke('export_items', { items }) : Promise.resolve(null)),
  setWallpaper: (id, edited) => (native ? invoke('set_wallpaper', { id, edited }) : Promise.resolve()),
  /** "ok" | "not_configured" (PC sem Windows Hello) | "cancel" | "busy" | "policy" | "error" */
  verify: message => (native ? invoke('verify_user', { message }) : Promise.resolve('not_configured')),
  importPaths: (paths, dest) => invoke('import_paths', { paths, dest }),
  /** [arquivos, bytes] que importPaths copiaria (já sem o que está na biblioteca), para confirmar antes */
  importPreview: (paths, dest) => (native ? invoke('import_preview', { paths, dest }) : Promise.resolve([0, 0])),
  launchFile: () => (native ? invoke('launch_file') : Promise.resolve(null)),
  openFile: path => invoke('open_file', { path }),
  defaultStatus: () => (native ? invoke('default_status') : Promise.resolve({ photos: false, videos: false })),
  openDefaultSettings: () => native && invoke('open_default_settings'),
  on(event, fn) {
    if (native) T.event.listen(event, e => fn(e.payload));
  },
  win: native ? T.window.getCurrentWindow() : null,
};

/** URLs: miniatura (cache do Shell) e arquivo inteiro. */
/** `fill`: a imagem vai preencher um quadrado (object-fit: cover) — o lado menor vem com `px` e já cortado. */
export function thumbUrl(it, px, editV, fill = false) {
  if (!native) return `https://picsum.photos/seed/${it.seed}/${demoSize(it, px)}`;
  const c = fill ? '&c=1' : '';
  // &m= (mtime): o arquivo alterado fora do app ganha URL nova e não sai do cache HTTP de 1 h
  return editV ? `http://thumb.localhost/r/${it.id}?s=${px}&v=${editV}${c}` : `http://thumb.localhost/${it.id}?s=${px}&m=${it.mtime}${c}`;
}
export function fullUrl(it, editV) {
  if (!native) return `https://picsum.photos/seed/${it.seed}/${demoSize(it, 1800)}`;
  return editV ? `http://foto.localhost/r/${it.id}?v=${editV}` : `http://foto.localhost/${it.id}?m=${it.mtime}`;
}
function demoSize(it, px) {
  const r = it.w / it.h;
  return r >= 1 ? `${px}/${Math.round(px / r)}` : `${Math.round(px * r)}/${px}`;
}

// ---------- demonstração ----------
let demo;
function demoItems() {
  if (demo) return demo;
  const out = [];
  const places = [
    [-23.55, -46.63], [-22.9, -43.2], [-19.92, -43.94], [48.85, 2.35], [41.9, 12.5], [40.71, -74.0], [-12.97, -38.5], [-27.6, -48.55],
  ];
  const now = Date.now();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let t = now - 4.2 * 365 * 864e5;
  let n = 0;
  while (t < now) {
    const burst = 1 + Math.floor(rnd() * (rnd() < 0.15 ? 26 : 7));
    const trip = rnd() < 0.08 ? places[3 + Math.floor(rnd() * 3)] : places[Math.floor(rnd() * 3)];
    for (let b = 0; b < burst; b++) {
      const d = new Date(t + b * rnd() * 3600e3);
      if (d > now) break;
      const ar = [[4, 3], [3, 4], [16, 9], [1, 1], [9, 16]][Math.floor(rnd() * 5)];
      const shot = rnd() < 0.05, video = !shot && rnd() < 0.08, pano = !shot && !video && rnd() < 0.015;
      const w = pano ? 6000 : ar[0] * 1000, h = pano ? 1600 : ar[1] * 1000;
      const pad = x => String(x).padStart(2, '0');
      out.push({
        id: 'd' + n,
        seed: 'f' + (n % 997),
        path: `C:\\Users\\Demo\\Pictures\\${shot ? 'Screenshots\\Captura de tela' : 'IMG_' + (1000 + n)}.${video ? 'mp4' : 'jpg'}`,
        name: `${shot ? 'Captura de tela ' + n : 'IMG_' + (1000 + n)}.${video ? 'MP4' : 'JPG'}`,
        dir: shot ? 'C:\\Users\\Demo\\Pictures\\Screenshots' : 'C:\\Users\\Demo\\Pictures\\Câmera',
        fmt: video ? 'MP4' : 'JPEG',
        video,
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
        w, h,
        size: Math.round(1.2e6 + rnd() * 4e6),
        mtime: 0,
        ...(shot || video ? {} : { make: 'Apple', model: 'iPhone 16 Pro', lens: 'iPhone 16 Pro back triple camera 6.765mm f/1.78', iso: 64 + Math.round(rnd() * 400), fnum: 1.78, exp: '1/' + (60 + Math.round(rnd() * 900)), focal: 6.765, f35: 24, lat: trip[0] + (rnd() - 0.5) * 0.08, lon: trip[1] + (rnd() - 0.5) * 0.08 }),
        ...(video ? { dur: 3 + rnd() * 90 } : {}),
      });
      n++;
    }
    t += (0.3 + rnd() * 5.5) * 864e5;
  }
  return (demo = out);
}
