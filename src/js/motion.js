// Movimento do Liquid Glass (o mesmo do app Email): luz que segue o cursor no vidro,
// bolha que desliza entre os botões de uma pílula, bolha de seleção na barra lateral
// e entrada suave das telas. Tudo por delegação: funciona com o DOM recriado a cada render.

const reduce = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- reflexo do vidro acompanha o cursor ----------
document.addEventListener('pointermove', e => {
  const g = e.target.closest?.('.glass');
  if (!g) return;
  const r = g.getBoundingClientRect();
  g.style.setProperty('--mx', `${e.clientX - r.left}px`);
  g.style.setProperty('--my', `${e.clientY - r.top}px`);
}, { passive: true });

// ---------- bolha que desliza entre os botões de um grupo ----------
// pílulas da barra de ferramentas, controles do player (Música), barras de seleção e de vídeo (Fotos)
const GROUP = '.pill, .player .ctrls, .player .right, .selbar, .vbarwrap';
const BTN = '.gbtn, .pb';
document.addEventListener('pointerover', e => {
  const b = e.target.closest?.(BTN);
  const group = b?.closest(GROUP);
  if (!group || b.disabled || b.parentElement !== group) return;
  let blob = group.querySelector(':scope > .hov');
  if (!blob) {
    blob = document.createElement('i');
    blob.className = 'hov';
    group.prepend(blob);
    group.classList.add('lg-group');
    group.addEventListener('pointerleave', () => group.classList.remove('hovering'));
  }
  const first = !group.classList.contains('hovering');
  if (first) blob.style.transition = 'none';
  blob.style.transform = `translate(${b.offsetLeft}px, ${b.offsetTop}px)`;
  blob.style.width = `${b.offsetWidth}px`;
  blob.style.height = `${b.offsetHeight}px`;
  if (first) {
    blob.offsetWidth;
    blob.style.transition = '';
  }
  group.classList.add('hovering');
}, { passive: true });
document.addEventListener('pointerdown', e => {
  const group = e.target.closest?.(GROUP);
  if (group && e.target.closest(BTN)?.matches(':not([disabled])')) group.classList.add('squish');
}, { passive: true });
addEventListener('pointerup', () => document.querySelectorAll('.lg-group.squish').forEach(p => p.classList.remove('squish')));

// ---------- bolha de seleção da barra lateral ----------
// A barra é recriada a cada navegação; a bolha é a mesma e só muda de lugar, com mola.
function sideKnob(nav) {
  const knob = document.createElement('i');
  knob.className = 'nav-knob';
  let placed = false;
  const place = () => {
    if (!knob.isConnected) nav.prepend(knob);
    const it = nav.querySelector('.nav-item.active');
    if (!it || !it.offsetParent || it.closest('.nav-sec.collapsed')) {
      knob.classList.remove('on');
      placed = false;
      return;
    }
    const y = it.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop;
    const x = it.getBoundingClientRect().left - nav.getBoundingClientRect().left;
    const t = `translate(${x}px, ${y}px)`;
    if (!placed || reduce.matches) {
      knob.style.transition = 'none';
      knob.style.transform = t;
      knob.style.width = `${it.offsetWidth}px`;
      knob.style.height = `${it.offsetHeight}px`;
      knob.offsetWidth;
      knob.style.transition = '';
    } else {
      knob.style.transform = t;
      knob.style.width = `${it.offsetWidth}px`;
      knob.style.height = `${it.offsetHeight}px`;
    }
    knob.classList.add('on');
    placed = true;
  };
  let raf = 0;
  const later = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(place);
  };
  new MutationObserver(muts => {
    // ignora a própria bolha entrando de volta
    if (muts.every(m => [...m.addedNodes, ...m.removedNodes].every(n => n === knob))) return;
    later();
  }).observe(nav, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  new ResizeObserver(later).observe(nav);
  nav.classList.add('has-knob');
  later();
}

// ---------- telas entram com um leve deslize ----------
function viewEnter(view) {
  new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || reduce.matches) continue;
        n.classList.add('view-enter');
        n.addEventListener('animationend', () => n.classList.remove('view-enter'), { once: true });
      }
    }
  }).observe(view, { childList: true });
}

function init() {
  const nav = document.getElementById('nav');
  if (nav) sideKnob(nav);
  const view = document.getElementById('view');
  if (view) viewEnter(view);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
