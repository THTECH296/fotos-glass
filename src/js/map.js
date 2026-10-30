// Mapa de fotos: agrupa por proximidade a cada nível de zoom, com a foto mais recente como pino.

import { thumbUrl } from './api.js';
import { h, icon, nf } from './util.js';
import { editV } from './store.js';

/** mapa base do OpenStreetMap (no tema escuro, invertido por CSS) */
export const tiles = () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' });

export function mapView(wrap, items, open) {
  if (!window.L) {
    wrap.append(h('div.empty', h('div.box', icon('map'), h('h2', 'Mapa indisponível'))));
    return () => {};
  }
  const box = h('div', { style: { position: 'absolute', inset: 0 } });
  wrap.append(box);
  const map = L.map(box, { zoomControl: false, worldCopyJump: true, minZoom: 2 }).setView([-15, -47], 4);
  tiles().addTo(map);
  if (items.length) {
    const b = L.latLngBounds(items.map(i => [i.lat, i.lon]));
    map.fitBounds(b, { padding: [80, 80], maxZoom: 13 });
  }
  wrap.append(h('div.map-zoom.glass',
    h('button.gbtn.round', { title: 'Aproximar', onclick: () => map.zoomIn() }, icon('plus')),
    h('button.gbtn.round', { title: 'Afastar', onclick: () => map.zoomOut() }, icon('minus'))));

  const layer = L.layerGroup().addTo(map);
  const draw = () => {
    layer.clearLayers();
    const z = map.getZoom();
    const cell = 72; // px
    const groups = new Map();
    for (const it of items) {
      const p = map.project([it.lat, it.lon], z);
      const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    }
    for (const g of groups.values()) {
      const lat = g.reduce((s, i) => s + i.lat, 0) / g.length, lon = g.reduce((s, i) => s + i.lon, 0) / g.length;
      const top = g.at(-1);
      const html = `<div class="mk"><div class="ph" style="background-image:url('${thumbUrl(top, 200, editV(top))}')"></div><div class="tail"></div>${g.length > 1 ? `<div class="ct">${nf.format(g.length)}</div>` : ''}</div>`;
      const m = L.marker([lat, lon], { icon: L.divIcon({ className: '', html, iconSize: [58, 58], iconAnchor: [29, 66] }) });
      m.on('click', () => {
        if (g.length > 1 && z < 15) {
          const b = L.latLngBounds(g.map(i => [i.lat, i.lon]));
          if (b.getNorthEast().equals(b.getSouthWest())) open(g, g.length - 1);
          else map.flyToBounds(b, { padding: [90, 90], maxZoom: 16, duration: 0.7 });
        } else open(g, g.length - 1);
      });
      layer.addLayer(m);
    }
  };
  map.on('zoomend', draw);
  draw();
  setTimeout(() => map.invalidateSize(), 50);
  return () => map.remove();
}
