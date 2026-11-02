// Grade virtual: só os quadrados visíveis existem no DOM, então 50 mil fotos rolam lisas.

import { thumbUrl } from './api.js';
import { icon, fmt } from './util.js';
import { isFav, editV } from './store.js';

const BUCKETS = [200, 320, 480, 720, 1024];

export class VGrid {
  constructor(o) {
    Object.assign(this, { cols: 5, aspect: false, badge: null, selection: null, selecting: () => false, onOpen() {}, onContext() {}, onSel() {}, onScroll() {} }, o);
    this.tiles = new Map();
    this.pool = [];
    this.host.classList.add('vgrid');
    this.raf = 0;
    this.scroller.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.ro = new ResizeObserver(() => this.layout(true));
    this.ro.observe(this.scroller);
    this.bind();
    this.layout();
  }

  destroy() {
    this.dead = true;
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
  }

  setItems(items, keepScroll = true) {
    const anchor = keepScroll ? this.anchor() : null;
    this.items = items;
    this.tiles.forEach(t => this.release(t));
    this.tiles.clear();
    this.layout();
    if (anchor) this.restore(anchor);
  }

  setCols(n) {
    n = Math.max(1, Math.min(24, Math.round(n)));
    if (n === this.cols) return;
    const anchor = this.anchor();
    this.cols = n;
    this.tiles.forEach(t => this.release(t));
    this.tiles.clear();
    this.layout();
    this.restore(anchor);
  }

  setAspect(v) {
    this.aspect = v;
    this.host.classList.toggle('aspect', v);
  }

  get gap() {
    return this.cols >= 12 ? 1 : 2;
  }

  layout(fromResize) {
    const W = this.host.clientWidth || this.scroller.clientWidth;
    if (!W) return;
    if (fromResize && W === this.lastW) return this.schedule();
    const anchor = fromResize && this.lastW ? this.anchor() : null;
    this.lastW = W;
    const g = this.gap;
    this.cell = (W - g * (this.cols - 1)) / this.cols;
    this.rowH = this.cell + g;
    this.rows = Math.ceil(this.items.length / this.cols);
    this.host.style.height = Math.max(0, this.rows * this.rowH - g) + 'px';
    const need = this.cell * Math.min(devicePixelRatio || 1, 2);
    this.px = BUCKETS.find(b => b >= need) || 1024;
    for (const [i, t] of this.tiles) this.place(t, i);
    if (anchor) this.restore(anchor);
    this.render();
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  offset() {
    return this.host.offsetTop;
  }

  render() {
    if (!this.rowH || this.dead) return;
    const top = this.scroller.scrollTop - this.offset();
    const vh = this.scroller.clientHeight;
    const r0 = Math.max(0, Math.floor((top - vh * 0.6) / this.rowH));
    const r1 = Math.min(this.rows - 1, Math.floor((top + vh * 1.6) / this.rowH));
    const lo = r0 * this.cols, hi = Math.min(this.items.length - 1, (r1 + 1) * this.cols - 1);
    for (const [i, t] of this.tiles) {
      if (i < lo || i > hi) {
        this.release(t);
        this.tiles.delete(i);
      }
    }
    for (let i = lo; i <= hi; i++) if (!this.tiles.has(i)) this.tiles.set(i, this.make(i));
    const first = Math.max(0, Math.floor(Math.max(0, top + 70) / this.rowH) * this.cols);
    this.onScroll(this.items[Math.min(first, this.items.length - 1)], top);
  }

  place(t, i) {
    const r = Math.floor(i / this.cols), c = i % this.cols, g = this.gap;
    const s = t.style;
    s.width = s.height = this.cell + 'px';
    s.transform = `translate(${c * (this.cell + g)}px, ${r * this.rowH}px)`;
  }

  make(i) {
    const it = this.items[i];
    let t = this.pool.pop();
    if (!t) {
      t = document.createElement('div');
      t.className = 'tile';
      t.append(document.createElement('img'));
      t.firstChild.decoding = 'async';
      t.firstChild.draggable = false;
      t.firstChild.onload = e => e.target.classList.add('ok');
      t.firstChild.onerror = e => e.target.classList.remove('ok');
    }
    t.dataset.i = i;
    this.place(t, i);
    const img = t.firstChild;
    const src = thumbUrl(it, this.px, editV(it), !this.aspect);
    if (img.getAttribute('src') !== src) {
      img.classList.remove('ok');
      img.src = src;
    }
    while (t.childNodes.length > 1) t.lastChild.remove();
    if (it.video) t.append(Object.assign(document.createElement('div'), { className: 'badge', textContent: fmt.dur(it.dur) }));
    else if (this.badge) {
      const b = this.badge(it);
      if (b) t.append(Object.assign(document.createElement('div'), { className: 'days', textContent: b }));
    }
    if (isFav(it) && this.cols < 14) {
      const f = document.createElement('div');
      f.className = 'fav';
      f.append(icon('heartFill'));
      t.append(f);
    }
    if (editV(it) && this.cols < 12) {
      const e = document.createElement('div');
      e.className = 'edited';
      e.append(icon('edit'));
      t.append(e);
    }
    const chk = document.createElement('div');
    chk.className = 'chk';
    t.append(chk);
    t.classList.toggle('sel', !!this.selection?.has(it.id));
    this.host.append(t);
    return t;
  }

  release(t) {
    t.remove();
    t.classList.remove('sel', 'focus', 'pop');
    this.pool.push(t);
  }

  refresh() {
    for (const [i, t] of this.tiles) {
      this.release(t);
      this.tiles.delete(i);
    }
    this.render();
  }

  syncSelection() {
    for (const [i, t] of this.tiles) t.classList.toggle('sel', !!this.selection?.has(this.items[i].id));
  }

  indexAtPoint(x, y) {
    const el = document.elementFromPoint(x, y)?.closest('.tile');
    return el && this.host.contains(el) ? +el.dataset.i : -1;
  }

  tileRect(i) {
    const t = this.tiles.get(i);
    return t ? t.getBoundingClientRect() : null;
  }

  anchor() {
    if (!this.rowH || !this.items.length) return null;
    const top = this.scroller.scrollTop - this.offset();
    const mid = top + this.scroller.clientHeight / 2;
    const row = Math.max(0, Math.floor(mid / this.rowH));
    const atBottom = this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 4;
    return { index: Math.min(this.items.length - 1, row * this.cols), frac: (mid - row * this.rowH) / this.rowH, atBottom };
  }

  restore(a) {
    if (!a) return;
    if (a.atBottom) return this.scrollToBottom();
    const row = Math.floor(a.index / this.cols);
    this.scroller.scrollTop = this.offset() + row * this.rowH + a.frac * this.rowH - this.scroller.clientHeight / 2;
    this.render();
  }

  scrollToIndex(i, align = 'center') {
    const row = Math.floor(i / this.cols);
    const y = this.offset() + row * this.rowH;
    const vh = this.scroller.clientHeight;
    if (align === 'center') this.scroller.scrollTop = y - vh / 2 + this.cell / 2;
    else if (align === 'top') this.scroller.scrollTop = y - 80;
    else if (align === 'nearest') {
      const cur = this.scroller.scrollTop;
      if (y < cur + 70) this.scroller.scrollTop = y - 80;
      else if (y + this.cell > cur + vh - 90) this.scroller.scrollTop = y + this.cell - vh + 100;
    }
    this.render();
  }

  scrollToBottom() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.render();
  }

  // ---------- cliques, menu de contexto e seleção arrastando ----------
  bind() {
    const host = this.host;
    let drag = null;
    host.addEventListener('click', e => {
      const t = e.target.closest('.tile');
      if (!t || this.dragged) return;
      const i = +t.dataset.i, it = this.items[i];
      if (this.selecting() || e.ctrlKey || e.metaKey || e.shiftKey) {
        if (e.shiftKey && this.lastClick != null) {
          const [a, b] = [Math.min(this.lastClick, i), Math.max(this.lastClick, i)];
          for (let k = a; k <= b; k++) this.selection.add(this.items[k].id);
        } else if (this.selection.has(it.id)) this.selection.delete(it.id);
        else this.selection.add(it.id);
        this.lastClick = i;
        this.syncSelection();
        this.onSel(true);
        return;
      }
      this.lastClick = i;
      this.onOpen(it, i, this.items);
    });
    host.addEventListener('contextmenu', e => {
      const t = e.target.closest('.tile');
      if (!t) return;
      e.preventDefault();
      const i = +t.dataset.i;
      this.onContext(this.items[i], i, e);
    });
    host.addEventListener('pointerdown', e => {
      this.dragged = false;
      if (e.button !== 0 || !this.selecting()) return;
      const i = this.indexAtPoint(e.clientX, e.clientY);
      if (i < 0) return;
      drag = { start: i, last: i, add: !this.selection.has(this.items[i].id), snap: new Set(this.selection), x: e.clientX, y: e.clientY };
    });
    const move = e => {
      if (!drag) return;
      if (!this.dragged && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      this.dragged = true;
      drag.cy = e.clientY;
      drag.cx = e.clientX;
      const i = this.indexAtPoint(e.clientX, e.clientY);
      if (i >= 0 && i !== drag.last) {
        drag.last = i;
        this.applyDrag(drag);
      }
      if (!drag.loop) {
        drag.loop = () => {
          if (!drag) return;
          const r = this.scroller.getBoundingClientRect();
          const edge = 70;
          let v = 0;
          if (drag.cy < r.top + edge) v = -(r.top + edge - drag.cy) / 3;
          else if (drag.cy > r.bottom - edge) v = (drag.cy - (r.bottom - edge)) / 3;
          if (v) {
            this.scroller.scrollTop += v;
            const j = this.indexAtPoint(drag.cx, Math.max(r.top + 4, Math.min(r.bottom - 4, drag.cy)));
            if (j >= 0 && j !== drag.last) {
              drag.last = j;
              this.applyDrag(drag);
            }
          }
          requestAnimationFrame(drag.loop);
        };
        requestAnimationFrame(drag.loop);
      }
    };
    const up = () => {
      if (drag && this.dragged) setTimeout(() => (this.dragged = false), 0);
      drag = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  applyDrag(d) {
    const [a, b] = [Math.min(d.start, d.last), Math.max(d.start, d.last)];
    this.selection.clear();
    d.snap.forEach(id => this.selection.add(id));
    for (let k = a; k <= b; k++) {
      const id = this.items[k].id;
      d.add ? this.selection.add(id) : this.selection.delete(id);
    }
    this.syncSelection();
    this.onSel(true);
  }
}
