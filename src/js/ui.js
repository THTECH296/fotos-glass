// Menus, alertas, folhas e avisos em vidro líquido.

import { h, icon } from './util.js';
import './motion.js';

let openMenu = null;

export function closeMenu() {
  if (openMenu) {
    const { el, back } = openMenu;
    const inside = el.contains(document.activeElement);
    openMenu.scrim.remove();
    el.remove();
    document.removeEventListener('keydown', openMenu.onKey, true);
    openMenu = null;
    if (inside && back?.isConnected) back.focus({ preventScroll: true });
  }
}

/**
 * items: [{label, icon, run, danger, tick, disabled} | '-' | {header}]
 * at: {x, y} ou um elemento (abre embaixo dele)
 */
export function menu(items, at) {
  closeMenu();
  items = items.filter(Boolean);
  // como no iOS/macOS: se algum item tem marca, todos reservam a coluna do ✓ (senão só ele ficava recuado)
  const ticks = items.some(m => m.tick !== undefined);
  const scrim = h('div.scrim.clear', { onpointerdown: closeMenu, oncontextmenu: e => (e.preventDefault(), closeMenu()) });
  const el = h('div.menu.glass', { role: 'menu' },
    items.map(m => {
      if (m === '-') return h('hr', { role: 'separator' });
      if (m.header) return h('div.mh', { role: 'presentation' }, m.header);
      return h('button.mi' + (m.danger ? '.danger' : ''), {
        role: m.tick !== undefined ? 'menuitemcheckbox' : 'menuitem',
        'aria-checked': m.tick !== undefined ? String(!!m.tick) : null,
        tabindex: '-1',
        disabled: m.disabled,
        onclick: () => { closeMenu(); m.run?.(); },
      }, ticks ? h('span.tick', { 'aria-hidden': 'true' }, m.tick ? '✓' : '') : null, h('span', m.label), m.kbd ? h('kbd', m.kbd) : null, m.icon ? icon(m.icon) : null);
    }));
  document.body.append(scrim, el);
  // offsetWidth/Height: o getBoundingClientRect pegava o menu já encolhido pela animação de entrada (scale .82)
  const r = { width: el.offsetWidth, height: el.offsetHeight };
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
  el.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  el.style.top = Math.max(8, y) + 'px';
  el.style.setProperty('--ox', `${oy} ${ox}`);
  // teclado: Esc fecha só o menu (sem encerrar a seleção por baixo); ↑/↓ andam; Enter/Espaço o botão faz sozinho
  const onKey = e => {
    const mis = [...el.querySelectorAll('.mi:not([disabled])')];
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      e.stopPropagation();
      if (!mis.length) return;
      const k = mis.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? mis.length - 1
        : e.key === 'ArrowDown' ? (k + 1) % mis.length : (k <= 0 ? mis.length - 1 : k - 1);
      mis[next].focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    } else if (!el.contains(document.activeElement) || (e.key !== 'Enter' && e.key !== ' ')) {
      // demais teclas (Delete, atalhos) não chegam à tela enquanto o menu está aberto
      e.stopPropagation();
    }
  };
  document.addEventListener('keydown', onKey, true);
  // o foco entra no menu (como no macOS) e volta para quem o abriu ao fechar
  const back = document.activeElement;
  openMenu = { el, scrim, onKey, back };
  el.querySelector('.mi:not([disabled])')?.focus({ preventScroll: true });
}

// ---------- alertas e folhas: modais de verdade ----------
// Foco inicial dentro do diálogo, Tab preso nele, o resto do app inerte e o foco devolvido ao fechar.
// Pilha: um alerta aberto por cima de uma folha (Ajustes) trata Esc/Tab sozinho, sem fechar os dois.
const modals = [];
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
let modalSeq = 0;

function modal(el, initial) {
  const scrim = h('div.scrim');
  const back = document.activeElement;
  el.setAttribute('aria-modal', 'true');
  el.tabIndex = -1;
  const head = el.querySelector('h2, h3');
  if (head) {
    head.id ||= 'dlg-' + ++modalSeq;
    el.setAttribute('aria-labelledby', head.id);
  }
  document.body.append(scrim, el);
  const entry = { el };
  modals.push(entry);
  setInert();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.style.transition = 'opacity .2s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'scale(.94)';
    scrim.style.transition = 'opacity .25s';
    scrim.style.opacity = '0';
    el.inert = true;
    setTimeout(() => { el.remove(); scrim.remove(); }, 250);
    document.removeEventListener('keydown', onKey, true);
    modals.splice(modals.indexOf(entry), 1);
    setInert();
    // devolve o foco só se ele ficou "perdido" (no próprio diálogo ou no body); quem já moveu o foco ganha
    const now = document.activeElement;
    if (back?.isConnected && (!now || now === document.body || el.contains(now))) back.focus({ preventScroll: true });
  };
  const onKey = e => {
    if (modals.at(-1) !== entry) return;
    if (e.key === 'Escape') { e.stopPropagation(); el.dispatchEvent(new Event('cancel')); }
    else if (e.key === 'Tab') {
      const f = [...el.querySelectorAll(FOCUSABLE)].filter(x => x.offsetParent !== null);
      if (!f.length) { e.preventDefault(); return; }
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? f.at(-1) : f[i - 1]) : (i < 0 || i === f.length - 1 ? f[0] : f[i + 1]);
      e.preventDefault();
      next.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  scrim.onclick = () => el.dispatchEvent(new Event('cancel'));
  requestAnimationFrame(() => {
    if (closed || el.contains(document.activeElement)) return;
    const t = typeof initial === 'function' ? initial() : initial;
    (t || el).focus({ preventScroll: true });
  });
  return close;
}

/** com um diálogo aberto, a janela por trás (barra lateral, grade, barras) sai do Tab e do leitor de tela */
function setInert() {
  const app = document.getElementById('app');
  if (app) app.inert = modals.length > 0;
}

/** alerta com botões; resolve com o índice do botão escolhido (ou -1 se cancelar) */
export function alertBox({ title, message, buttons = [{ label: 'OK', primary: true }], input }) {
  return new Promise(res => {
    const field = input ? h('input', { value: input.value || '', placeholder: input.placeholder || '', spellcheck: false, 'aria-label': title }) : null;
    const btns = buttons.map((b, i) => h('button' + (b.primary ? '.primary' : '') + (b.destructive ? '.destructive' : ''), { onclick: () => done(i) }, b.label));
    const el = h('div.alert.glass', { role: 'alertdialog' },
      h('h3', title), message ? h('p', message) : null, field,
      h('div.btns', btns));
    // foco inicial: o campo; senão o botão principal; num alerta destrutivo, o Cancelar (o iOS nunca deixa o Apagar no Enter)
    const close = modal(el, field || btns[buttons.findIndex(b => b.primary)] || btns[0]);
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
  // monta antes de abrir: o modal() precisa do título (aria-labelledby)
  let close = () => {};
  build(el, () => close());
  close = modal(el);
  el.addEventListener('cancel', close);
  return close;
}

let toastEl;
export function toast(text, ic = 'check') {
  toastEl?.remove();
  const el = (toastEl = h('div.toast.glass', { role: 'status' }, icon(ic), h('span', text)));
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
  // o "press" é solto no próprio elemento: um listener em window por controle vazava a cada renderChrome
  el.addEventListener('pointerdown', () => el.classList.add('press'));
  const release = () => el.classList.remove('press');
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, release);
  requestAnimationFrame(move);
  watchSize(el, move);
  el.set = v => set(v, false);
  return el;
}

// Um único ResizeObserver para todos os controles segmentados. Os que já saíram do DOM
// são soltos na próxima criação, para o observador não segurar elementos mortos.
const segMoves = new Map();
const segRO = new ResizeObserver(entries => entries.forEach(en => segMoves.get(en.target)?.()));
function watchSize(el, move) {
  for (const old of segMoves.keys()) {
    if (!old.isConnected) {
      segRO.unobserve(old);
      segMoves.delete(old);
    }
  }
  segMoves.set(el, move);
  segRO.observe(el);
}
