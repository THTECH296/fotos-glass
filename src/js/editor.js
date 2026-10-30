// Editor não destrutivo: o original nunca é alterado. Os ajustes ficam guardados e uma cópia
// renderizada (JPEG) é usada na grade e no visualizador; "Reverter ao Original" apaga a cópia.

import { api, fullUrl } from './api.js';
import { h, icon } from './util.js';
import { S, save } from './store.js';
import { confirmBox, toast, segmented } from './ui.js';

const ADJ = [
  ['auto', 'Auto', 'wand'],
  ['exposure', 'Exposição', 'exposure'],
  ['brilliance', 'Brilho Intenso', 'brilliance'],
  ['highlights', 'Realces', 'highlights'],
  ['shadows', 'Sombras', 'shadows'],
  ['contrast', 'Contraste', 'contrast'],
  ['brightness', 'Brilho', 'sun'],
  ['blackpoint', 'Ponto Preto', 'blackpoint'],
  ['saturation', 'Saturação', 'drop'],
  ['vibrance', 'Vibração', 'vibrance'],
  ['warmth', 'Calor', 'warmth'],
  ['tint', 'Tonalidade', 'tint'],
  ['sharpness', 'Nitidez', 'sharp'],
  ['vignette', 'Vinheta', 'vignette'],
];
const KEYS = ADJ.slice(1).map(a => a[0]);
const POSITIVE = new Set(['sharpness', 'vignette']);

const FILTERS = [
  ['none', 'Original', {}],
  ['vivid', 'Vívido', { saturation: 28, contrast: 14, vibrance: 10 }],
  ['vividWarm', 'Vívido Quente', { saturation: 26, contrast: 12, warmth: 30 }],
  ['vividCool', 'Vívido Frio', { saturation: 26, contrast: 12, warmth: -30 }],
  ['dramatic', 'Dramático', { contrast: 34, highlights: -40, shadows: -10, saturation: -18, brilliance: 10 }],
  ['dramaticWarm', 'Dramático Quente', { contrast: 32, highlights: -38, saturation: -10, warmth: 30 }],
  ['dramaticCool', 'Dramático Frio', { contrast: 32, highlights: -38, saturation: -10, warmth: -32 }],
  ['mono', 'Mono', { mono: 100 }],
  ['silvertone', 'Prateado', { mono: 100, contrast: 12, brightness: 8, tone: 1 }],
  ['noir', 'Noir', { mono: 100, contrast: 55, blackpoint: 30, highlights: 10 }],
];
const ASPECTS = [['free', 'Livre', 0], ['orig', 'Original', -1], ['1', 'Quadrado', 1], ['16:9', '16:9', 16 / 9], ['4:3', '4:3', 4 / 3], ['3:2', '3:2', 3 / 2], ['5:4', '5:4', 5 / 4], ['9:16', '9:16', 9 / 16], ['3:4', '3:4', 3 / 4]];

const blank = () => ({ ...Object.fromEntries(KEYS.map(k => [k, 0])), filter: 'none', filterAmt: 100, rot: 0, flip: false, angle: 0, crop: [0, 0, 1, 1], aspect: 'free', auto: false });

// ---------- WebGL ----------
const VS = `attribute vec2 p; varying vec2 v; void main(){ v = vec2(p.x*.5+.5, .5-p.y*.5); gl_Position = vec4(p,0.,1.); }`;
const FS = `precision highp float;
varying vec2 v;
uniform sampler2D T; uniform vec2 TS;
uniform vec4 C; uniform float ANG, ZM, AR; uniform int ROT; uniform float FL;
uniform float A[16]; uniform float MONO, TONE, ORIG;
float luma(vec3 c){ return dot(c, vec3(.2126,.7152,.0722)); }
vec2 src(vec2 p){
  vec2 c = p - .5; c.x *= AR;
  float s = sin(ANG), k = cos(ANG);
  c = mat2(k, s, -s, k) * c / ZM;
  c.x /= AR; p = c + .5;
  if (FL > .5) p.x = 1. - p.x;
  if (ROT == 1) p = vec2(p.y, 1. - p.x);
  else if (ROT == 2) p = vec2(1. - p.x, 1. - p.y);
  else if (ROT == 3) p = vec2(1. - p.y, p.x);
  return p;
}
void main(){
  vec2 q = C.xy + v * C.zw;
  vec2 uv = src(q);
  if (uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1.) { gl_FragColor = vec4(0.,0.,0.,1.); return; }
  vec3 c = texture2D(T, uv).rgb;
  if (ORIG > .5) { gl_FragColor = vec4(c,1.); return; }
  float sh = A[11];
  if (sh > 0.) {
    vec2 px = 1. / TS;
    vec3 b = (texture2D(T, uv + vec2(px.x,0.)).rgb + texture2D(T, uv - vec2(px.x,0.)).rgb + texture2D(T, uv + vec2(0.,px.y)).rgb + texture2D(T, uv - vec2(0.,px.y)).rgb) * .25;
    c += (c - b) * sh * 2.2;
  }
  c *= pow(2., A[0] * 1.6);                         // exposição
  float l = luma(c);
  c += A[1] * (.32 * (1. - smoothstep(0., .55, l)) - .18 * smoothstep(.55, 1., l)) ; // brilho intenso
  l = luma(c);
  c += c * A[2] * .55 * smoothstep(.45, 1., l);       // realces
  c += A[3] * .38 * (1. - smoothstep(0., .5, l)) * (1. - l);   // sombras
  c = (c - .5) * (1. + A[4] * .7) + .5;                // contraste
  c = pow(max(c, 0.), vec3(1. / (1. + A[5] * .55)));   // brilho
  float bp = A[6] * .16; c = (c - bp) / (1. - bp);     // ponto preto
  l = luma(c);
  c = mix(vec3(l), c, 1. + A[7]);                      // saturação
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, 1. + A[8] * (1. - (mx - mn)) * 1.2); // vibração
  c.r += A[9] * .09; c.b -= A[9] * .09;                // calor
  c.g -= A[10] * .07; c.rb += A[10] * .025;            // tonalidade
  float g = luma(c);
  vec3 mono = vec3(g);
  if (TONE > .5) mono = vec3(g) * vec3(1.02, 1., .97) + vec3(.01, .008, .0);
  c = mix(c, mono, MONO);
  float d = distance(v, vec2(.5));
  c *= 1. - A[12] * .85 * smoothstep(.25, .85, d);     // vinheta
  gl_FragColor = vec4(clamp(c, 0., 1.), 1.);
}`;

function glSetup(canvas) {
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(pr);
  gl.useProgram(pr);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = n => gl.getUniformLocation(pr, n);
  return { gl, u: { T: u('T'), TS: u('TS'), C: u('C'), ANG: u('ANG'), ZM: u('ZM'), AR: u('AR'), ROT: u('ROT'), FL: u('FL'), A: u('A'), MONO: u('MONO'), TONE: u('TONE'), ORIG: u('ORIG') } };
}

/** valores efetivos (ajustes do usuário + filtro) em -1..1 */
function effective(st) {
  const f = FILTERS.find(f => f[0] === st.filter)?.[2] || {};
  const k = st.filterAmt / 100;
  const val = key => Math.max(-1, Math.min(1, (st[key] + (f[key] || 0) * k) / 100));
  return { A: KEYS.map(val).concat([0, 0, 0]), mono: ((f.mono || 0) / 100) * k, tone: f.tone ? 1 : 0 };
}

function zoomFor(angle, ar) {
  const a = Math.abs(angle);
  return Math.cos(a) + Math.max(ar, 1 / ar) * Math.sin(a);
}

// ---------- editor ----------
export async function openEditor(it, onDone) {
  const prev = S.data.edits[it.id];
  const st = { ...blank(), ...(prev || {}) };
  delete st.v;
  const start = JSON.stringify(st);

  const canvas = h('canvas.e-canvas');
  const stage = h('div.e-stage', canvas);
  const el = h('div.editor');
  const loading = h('div.e-loading', h('div.spin'));
  stage.append(loading);
  document.body.append(el);

  let tab = 'adjust', tool = 'exposure', showOrig = false;
  const G = glSetup(canvas);
  const { gl, u } = G;

  // carrega a imagem pela tela 2D (aplica a orientação EXIF) e limita ao tamanho de textura
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = fullUrl(it);
  }).catch(() => null);
  if (!img) {
    el.remove();
    toast('Não foi possível abrir esta foto para edição', 'info');
    return;
  }
  const maxT = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
  const sc = Math.min(1, maxT / Math.max(img.naturalWidth, img.naturalHeight));
  const srcW = Math.round(img.naturalWidth * sc), srcH = Math.round(img.naturalHeight * sc);
  const c2 = document.createElement('canvas');
  c2.width = srcW;
  c2.height = srcH;
  c2.getContext('2d').drawImage(img, 0, 0, srcW, srcH);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, c2);
  loading.remove();

  const oriented = () => (st.rot % 2 ? [srcH, srcW] : [srcW, srcH]);

  function draw(w, hgt, { full = false, orig = false } = {}) {
    canvas.width = w;
    canvas.height = hgt;
    gl.viewport(0, 0, w, hgt);
    const [ow, oh] = oriented();
    const ar = ow / oh;
    const ang = (st.angle * Math.PI) / 180;
    const e = effective(st);
    gl.uniform1i(u.T, 0);
    gl.uniform2f(u.TS, srcW, srcH);
    gl.uniform4fv(u.C, full ? [0, 0, 1, 1] : st.crop);
    gl.uniform1f(u.ANG, ang);
    gl.uniform1f(u.ZM, zoomFor(ang, ar));
    gl.uniform1f(u.AR, ar);
    gl.uniform1i(u.ROT, st.rot);
    gl.uniform1f(u.FL, st.flip ? 1 : 0);
    gl.uniform1fv(u.A, new Float32Array(e.A));
    gl.uniform1f(u.MONO, e.mono);
    gl.uniform1f(u.TONE, e.tone);
    gl.uniform1f(u.ORIG, orig ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** desenha cabendo no palco */
  let raf = 0;
  function render() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const full = tab === 'crop';
      const [ow, oh] = oriented();
      const cw = full ? ow : ow * st.crop[2], ch = full ? oh : oh * st.crop[3];
      const W = stage.clientWidth - 80, H = stage.clientHeight - 60;
      const s = Math.min(W / cw, H / ch);
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const dw = Math.max(1, Math.round(cw * s)), dh = Math.max(1, Math.round(ch * s));
      canvas.style.width = dw + 'px';
      canvas.style.height = dh + 'px';
      draw(Math.min(Math.round(dw * dpr), 4096), Math.min(Math.round(dh * dpr), 4096), { full, orig: showOrig });
      if (full) placeCrop();
    });
  }

  // ---------- barra superior ----------
  const doneBtn = h('button.gbtn.round.e-done', { title: 'Concluído (Enter)', onclick: finish }, icon('check'));
  const top = h('div.e-top',
    h('div.pill.glass.dim', h('button.gbtn.round', { title: 'Cancelar (Esc)', onclick: cancel }, icon('close'))),
    h('div.e-title', 'Editar'),
    h('div.pill.glass.dim', h('button.gbtn', { title: 'Restaurar tudo', onclick: () => { Object.assign(st, blank()); syncAll(); } }, 'Reverter')),
    h('div.pill.glass.dim', doneBtn));

  // comparar: segurar o clique na foto mostra o original
  stage.addEventListener('pointerdown', e => {
    if (tab === 'crop' || e.button !== 0) return;
    showOrig = true;
    stage.classList.add('orig');
    render();
  });
  addEventListener('pointerup', () => {
    if (!showOrig) return;
    showOrig = false;
    stage.classList.remove('orig');
    render();
  });

  // ---------- régua ----------
  function ruler(get, set, min, max) {
    const ticks = h('div.r-ticks');
    const num = h('div.r-num');
    const r = h('div.ruler', num, h('div.r-win', ticks), h('div.r-mark'));
    const ppu = 4;
    const upd = () => {
      const v = get();
      ticks.style.transform = `translateX(${-v * ppu}px)`;
      num.textContent = Math.round(v);
      num.classList.toggle('zero', Math.round(v) === 0);
    };
    let d = null;
    r.addEventListener('pointerdown', e => { d = { x: e.clientX, v: get() }; r.setPointerCapture(e.pointerId); r.classList.add('drag'); });
    r.addEventListener('pointermove', e => {
      if (!d) return;
      let v = d.v - (e.clientX - d.x) / ppu;
      v = Math.max(min, Math.min(max, v));
      if (Math.abs(v) < 1.2) v = 0;
      set(v);
      upd();
    });
    r.addEventListener('pointerup', () => { d = null; r.classList.remove('drag'); });
    r.addEventListener('dblclick', () => { set(0); upd(); });
    r.addEventListener('wheel', e => { e.preventDefault(); set(Math.max(min, Math.min(max, get() - Math.sign(e.deltaY || e.deltaX) * 2))); upd(); }, { passive: false });
    ticks.style.setProperty('--min', min * ppu + 'px');
    ticks.style.width = (max - min) * ppu + 'px';
    ticks.style.left = `calc(50% + ${min * ppu}px)`;
    r.upd = upd;
    upd();
    return r;
  }

  // ---------- Ajustar ----------
  const toolBtns = new Map();
  const adjRuler = ruler(() => (tool === 'auto' ? 0 : st[tool]), v => { if (tool !== 'auto') { st[tool] = v; st.auto = false; render(); paintBtn(tool); } }, -100, 100);
  const toolRow = h('div.e-tools', ADJ.map(([k, label, ic]) => {
    const b = h('button.e-tool', { title: label, onclick: () => pickTool(k) }, h('div.ring', icon(ic), h('span.val')), h('span.lbl', label));
    toolBtns.set(k, b);
    return b;
  }));
  const toolName = h('div.e-toolname');
  function paintBtn(k) {
    const b = toolBtns.get(k);
    if (!b) return;
    const v = k === 'auto' ? (st.auto ? 100 : 0) : st[k];
    b.classList.toggle('changed', Math.round(v) !== 0);
    b.querySelector('.ring').style.setProperty('--p', Math.abs(v) + '%');
    b.querySelector('.ring').style.setProperty('--neg', v < 0 ? 1 : 0);
    b.querySelector('.val').textContent = k === 'auto' ? '' : Math.round(v);
  }
  function pickTool(k) {
    if (k === 'auto') {
      st.auto = !st.auto;
      if (st.auto) autoEnhance();
      else for (const key of ['exposure', 'contrast', 'shadows', 'highlights', 'vibrance', 'brilliance']) st[key] = 0;
      ADJ.forEach(a => paintBtn(a[0]));
      render();
    }
    tool = k;
    toolBtns.forEach((b, key) => b.classList.toggle('on', key === k));
    toolName.textContent = ADJ.find(a => a[0] === k)[1].toUpperCase();
    adjRuler.classList.toggle('hidden', k === 'auto');
    adjRuler.upd();
    toolBtns.get(k).scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' });
  }
  function autoEnhance() {
    // histograma de uma versão pequena
    draw(64, 64, { orig: true });
    const px = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let sum = 0, lo = 0, hi = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      sum += l;
      if (l < 0.08) lo++;
      if (l > 0.94) hi++;
    }
    const n = px.length / 4, mean = sum / n;
    st.exposure = Math.max(-40, Math.min(40, (0.48 - mean) * 120));
    st.shadows = lo / n > 0.08 ? 28 : 12;
    st.highlights = hi / n > 0.05 ? -30 : -8;
    st.contrast = 10;
    st.vibrance = 18;
    st.brilliance = 14;
  }
  const adjustPane = h('div.e-pane', toolName, adjRuler, toolRow);

  // ---------- Filtros ----------
  const filterRow = h('div.e-filters');
  const filterRuler = ruler(() => st.filterAmt, v => { st.filterAmt = Math.max(0, v); render(); }, 0, 100);
  const filterPane = h('div.e-pane.hidden', h('div.e-toolname', 'INTENSIDADE'), filterRuler, filterRow);
  function buildFilters() {
    const saved = { filter: st.filter, filterAmt: st.filterAmt };
    const [ow, oh] = oriented();
    const ar = (ow * st.crop[2]) / (oh * st.crop[3]);
    const tw = ar >= 1 ? 150 : Math.round(150 * ar), th = ar >= 1 ? Math.round(150 / ar) : 150;
    filterRow.replaceChildren(...FILTERS.map(([k, label]) => {
      st.filter = k;
      st.filterAmt = 100;
      draw(tw, th);
      const url = canvas.toDataURL('image/jpeg', 0.8);
      return h('button.e-filter' + (saved.filter === k ? '.on' : ''), { dataset: { k }, onclick: () => {
        st.filter = k;
        if (k !== 'none' && st.filterAmt === 0) st.filterAmt = 100;
        filterRow.querySelectorAll('.e-filter').forEach(b => b.classList.toggle('on', b.dataset.k === k));
        filterRuler.upd();
        render();
      } }, h('img', { src: url }), h('span', label));
    }));
    Object.assign(st, saved);
    render();
  }

  // ---------- Cortar ----------
  const cropBox = h('div.crop', h('div.grid3'), ...['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'].map(k => h('div.hd.' + k, { dataset: { k } })));
  stage.append(cropBox);
  const straight = ruler(() => st.angle, v => { st.angle = v; render(); }, -45, 45);
  const aspectRow = h('div.e-aspects', ASPECTS.map(([k, label]) => h('button.chip' + (st.aspect === k ? '.on' : ''), { dataset: { k }, onclick: () => setAspect(k) }, label)));
  const cropPane = h('div.e-pane.hidden',
    h('div.e-toolname', 'ENDIREITAR'), straight,
    h('div.e-croprow',
      h('div.pill.glass.dim', h('button.gbtn.round', { title: 'Girar 90°', onclick: rotate }, icon('rotate')), h('button.gbtn.round', { title: 'Espelhar', onclick: () => { st.flip = !st.flip; render(); } }, icon('flip'))),
      aspectRow,
      h('div.pill.glass.dim', h('button.gbtn', { onclick: () => { st.crop = [0, 0, 1, 1]; st.angle = 0; st.aspect = 'free'; straight.upd(); markAspect(); render(); } }, 'Redefinir'))));

  function rotate() {
    st.rot = (st.rot + 3) % 4; // anti-horário, como no iOS
    const [x, y, w, hh] = st.crop;
    st.crop = [y, 1 - x - w, hh, w];
    render();
  }
  function markAspect() {
    aspectRow.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b.dataset.k === st.aspect));
  }
  function ratioOf(k) {
    const a = ASPECTS.find(a => a[0] === k)?.[2] || 0;
    if (a === -1) { const [ow, oh] = oriented(); return ow / oh; }
    return a;
  }
  function setAspect(k) {
    st.aspect = k;
    markAspect();
    const r = ratioOf(k);
    if (r) {
      const [ow, oh] = oriented();
      // maior retângulo com a proporção r (em pixels) dentro do quadro, centralizado no recorte atual
      let w = 1, hh = (ow / r) / oh;
      if (hh > 1) { hh = 1; w = (oh * r) / ow; }
      const cx = st.crop[0] + st.crop[2] / 2, cy = st.crop[1] + st.crop[3] / 2;
      st.crop = [Math.max(0, Math.min(1 - w, cx - w / 2)), Math.max(0, Math.min(1 - hh, cy - hh / 2)), w, hh];
    }
    render();
  }
  function placeCrop() {
    const r = canvas.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const [x, y, w, hh] = st.crop;
    Object.assign(cropBox.style, { left: r.left - s.left + x * r.width + 'px', top: r.top - s.top + y * r.height + 'px', width: w * r.width + 'px', height: hh * r.height + 'px' });
  }
  let cd = null;
  cropBox.addEventListener('pointerdown', e => {
    e.stopPropagation();
    cd = { k: e.target.dataset.k || 'move', x: e.clientX, y: e.clientY, c: [...st.crop], r: canvas.getBoundingClientRect() };
    cropBox.setPointerCapture(e.pointerId);
    cropBox.classList.add('drag');
  });
  cropBox.addEventListener('pointermove', e => {
    if (!cd) return;
    const dx = (e.clientX - cd.x) / cd.r.width, dy = (e.clientY - cd.y) / cd.r.height;
    let [x, y, w, hh] = cd.c;
    const min = 0.06;
    if (cd.k === 'move') {
      x = Math.max(0, Math.min(1 - w, x + dx));
      y = Math.max(0, Math.min(1 - hh, y + dy));
    } else {
      let x2 = x + w, y2 = y + hh;
      if (cd.k.includes('w')) x = Math.max(0, Math.min(x2 - min, x + dx));
      if (cd.k.includes('e')) x2 = Math.min(1, Math.max(x + min, x2 + dx));
      if (cd.k.includes('n')) y = Math.max(0, Math.min(y2 - min, y + dy));
      if (cd.k.includes('s')) y2 = Math.min(1, Math.max(y + min, y2 + dy));
      w = x2 - x;
      hh = y2 - y;
      const r = ratioOf(st.aspect);
      if (r) {
        const [ow, oh] = oriented();
        const want = (w * ow) / r / oh;
        if (cd.k === 'n' || cd.k === 's') w = Math.min(1, (hh * oh * r) / ow);
        else hh = Math.min(1, want);
        if (cd.k.includes('n')) y = y2 - hh;
        if (cd.k.includes('w')) x = x2 - w;
        x = Math.max(0, Math.min(1 - w, x));
        y = Math.max(0, Math.min(1 - hh, y));
      }
    }
    st.crop = [x, y, w, hh];
    placeCrop();
  });
  cropBox.addEventListener('pointerup', () => { cd = null; cropBox.classList.remove('drag'); });

  // ---------- abas ----------
  const tabs = segmented([{ value: 'adjust', label: 'Ajustar' }, { value: 'filters', label: 'Filtros' }, { value: 'crop', label: 'Cortar' }], tab, v => setTab(v));
  tabs.classList.add('dim');
  function setTab(v) {
    tab = v;
    adjustPane.classList.toggle('hidden', v !== 'adjust');
    filterPane.classList.toggle('hidden', v !== 'filters');
    cropPane.classList.toggle('hidden', v !== 'crop');
    stage.classList.toggle('cropping', v === 'crop');
    if (v === 'filters') buildFilters();
    render();
  }
  function syncAll() {
    ADJ.forEach(a => paintBtn(a[0]));
    adjRuler.upd();
    filterRuler.upd();
    straight.upd();
    markAspect();
    if (tab === 'filters') buildFilters();
    render();
  }

  el.append(stage, top, h('div.e-bottom', adjustPane, filterPane, cropPane, h('div.e-tabs', tabs)));
  pickTool('exposure');
  ADJ.forEach(a => paintBtn(a[0]));
  render();
  const ro = new ResizeObserver(render);
  ro.observe(stage);

  const onKey = e => {
    if (document.querySelector('.alert')) return;
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    else if (e.key === 'Enter') { e.stopPropagation(); finish(); }
  };
  document.addEventListener('keydown', onKey, true);

  function close() {
    ro.disconnect();
    document.removeEventListener('keydown', onKey, true);
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  async function cancel() {
    if (JSON.stringify(st) !== start && !(await confirmBox('Descartar alterações?', '', 'Descartar'))) return;
    close();
  }
  async function finish() {
    const clean = JSON.stringify({ ...st, auto: false }) === JSON.stringify({ ...blank(), auto: false });
    if (JSON.stringify(st) === start) return close();
    doneBtn.disabled = true;
    if (clean) {
      delete S.data.edits[it.id];
      await api.deleteRender(it.id);
    } else {
      const [ow, oh] = oriented();
      const w = Math.round(ow * st.crop[2]), hh = Math.round(oh * st.crop[3]);
      draw(w, hh);
      const data = canvas.toDataURL('image/jpeg', 0.93);
      try {
        await api.saveRender(it.id, data);
      } catch (e) {
        doneBtn.disabled = false;
        return toast('Erro ao salvar: ' + e, 'info');
      }
      S.data.edits[it.id] = { ...st, v: Date.now().toString(36) };
    }
    save();
    close();
    onDone?.();
  }
}
