// Menus, alertas, folhas e avisos em vidro líquido.

import { h, icon } from './util.js';

let openMenu = null;

export function closeMenu() {
  if (openMenu) {
    openMenu.scrim.remove();
    openMenu.el.remove();
    openMenu = null;
  }
}

/**
 * items: [{label, icon, run, danger, tick, disabled} | '-' | {header}]
 * at: {x, y} ou um elemento (abre embaixo dele)
 */
export function menu(items, at) {
  closeMenu();
  const scrim = h('div.scrim.clear', { onpointerdown: closeMenu, oncontextmenu: e => (e.preventDefault(), closeMenu()) });
  const el = h('div.menu.glass', { role: 'menu' },
    items.filter(Boolean).map(m => {
      if (m === '-') return h('hr');
      if (m.header) return h('div.mh', m.header);
      return h('button.mi' + (m.danger ? '.danger' : ''), {
        disabled: m.disabled,
        style: m.disabled ? { opacity: .4 } : null,
        onclick: () => { closeMenu(); m.run?.(); },
      }, m.tick !== undefined ? h('span.tick', m.tick ? '✓' : '') : null, h('span', m.label), m.icon ? icon(m.icon) : null);
    }));
  document.body.append(scrim, el);
  const r = el.getBoundingClientRect();
  let x, y, ox = 'left', oy = 'top';
  if (at instanceof Element) {
    const b = at.getBoundingClientRect();
    x = b.right - r.width;
    y = b.bottom + 8;
    if (x < 8) x = b.left;
    ox = x === b.left ? 'left' : 'right';
    if (y + r.height > innerHeight - 8) { y = b.top - r.height - 8; oy = 'bottom'; }
  } else {
    x = at.x; y = at.y;
    if (x + r.width > innerWidth - 8) { x = at.x - r.width; ox = 'right'; }
    if (y + r.height > innerHeight - 8) { y = Math.max(8, at.y - r.height); oy = 'bottom'; }
  }
  el.style.left = Math.max(8, x) + 'px';
  el.style.top = Math.max(8, y) + 'px';
  el.style.setProperty('--ox', `${oy} ${ox}`);
  openMenu = { el, scrim };
}

function modal(el) {
  const scrim = h('div.scrim');
  document.body.append(scrim, el);
  const close = () => {
    el.style.transition = 'opacity .2s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'scale(.94)';
    scrim.style.transition = 'opacity .25s';
    scrim.style.opacity = '0';
    setTimeout(() => { el.remove(); scrim.remove(); }, 250);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); el.dispatchEvent(new Event('cancel')); }
  };
  document.addEventListener('keydown', onKey, true);
  scrim.onclick = () => el.dispatchEvent(new Event('cancel'));
  return close;
}

/** alerta com botões; resolve com o índice do botão escolhido (ou -1 se cancelar) */
export function alertBox({ title, message, buttons = [{ label: 'OK', primary: true }], input }) {
  return new Promise(res => {
    const field = input ? h('input', { value: input.value || '', placeholder: input.placeholder || '', spellcheck: false }) : null;
    const el = h('div.alert.glass', { role: 'dialog' },
      h('h3', title), message ? h('p', message) : null, field,
      h('div.btns', buttons.map((b, i) => h('button' + (b.primary ? '.primary' : '') + (b.destructive ? '.destructive' : ''), { onclick: () => done(i) }, b.label))));
    const close = modal(el);
    const done = i => { close(); res(input ? (i >= 0 && buttons[i].primary ? field.value.trim() : null) : i); };
    el.addEventListener('cancel', () => done(-1));
    if (field) {
      setTimeout(() => { field.focus(); field.select(); }, 30);
      field.onkeydown = e => { if (e.key === 'Enter') done(buttons.findIndex(b => b.primary)); };
    }
  });
}

export const prompt = (title, value = '', placeholder = '', ok = 'Salvar') =>
  alertBox({ title, input: { value, placeholder }, buttons: [{ label: 'Cancelar' }, { label: ok, primary: true }] });

export async function confirmBox(title, message, ok = 'Apagar', destructive = true) {
  const i = await alertBox({ title, message, buttons: [{ label: 'Cancelar' }, { label: ok, destructive, primary: !destructive }] });
  return i === 1;
}

/** folha central (Ajustes, escolher álbum…) */
export function sheet(build) {
  const el = h('div.sheet.glass', { role: 'dialog' });
  const close = modal(el);
  el.addEventListener('cancel', close);
  build(el, close);
  return close;
}

let toastEl;
export function toast(text, ic = 'check') {
  toastEl?.remove();
  const el = (toastEl = h('div.toast.glass', icon(ic), h('span', text)));
  document.body.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, 2200);
}

export function switchEl(on, change) {
  const s = h('button.switch' + (on ? '.on' : ''), { role: 'switch', 'aria-checked': String(on) });
  s.onclick = () => {
    const v = !s.classList.contains('on');
    s.classList.toggle('on', v);
    s.setAttribute('aria-checked', String(v));
    change(v);
  };
  return s;
}

/** controle segmentado de vidro com "gota" que escorrega e incha ao pressionar */
export function segmented(options, value, change, cls = 'seg') {
  const knob = h('div.knob');
  const btns = options.map(o => h('button', { dataset: { v: o.value }, onclick: () => set(o.value, true) }, o.icon ? icon(o.icon) : null, o.label));
  const el = h(`div.${cls}.glass`, knob, btns);
  const move = () => {
    const b = btns.find(b => b.dataset.v === String(value));
    if (!b) return;
    knob.style.left = b.offsetLeft + 'px';
    knob.style.width = b.offsetWidth + 'px';
    btns.forEach(x => x.classList.toggle('active', x === b));
  };
  const set = (v, user) => {
    value = v;
    move();
    if (user) change(v);
  };
  el.addEventListener('pointerdown', () => el.classList.add('press'));
  addEventListener('pointerup', () => el.classList.remove('press'));
  requestAnimationFrame(move);
  new ResizeObserver(move).observe(el);
  el.set = v => set(v, false);
  return el;
}
