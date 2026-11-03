// Editor não destrutivo: o original nunca é alterado. Os ajustes ficam guardados e uma cópia
// renderizada (JPEG para foto, MP4 para vídeo) é usada na grade e no visualizador;
// "Reverter ao Original" apaga a cópia. No vídeo, cada quadro passa pelo mesmo WebGL da foto
// (Ajustar/Filtros/Cortar) e a aba Vídeo apara o início e o fim e tira o som.

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
// réguas que começam no 0: a nitidez negativa não faz nada no shader. A vinheta negativa clareia
// as bordas, como no iOS, por isso fica com a régua inteira.
const POSITIVE = new Set(['sharpness']);
// o que o Auto mexe (e devolve ao desligar)
const AUTO_KEYS = ['exposure', 'contrast', 'shadows', 'highlights', 'vibrance', 'brilliance'];

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
const ASPECTS = [['free', 'Livre', 0], ['orig', 'Original', -1], ['1', 'Quadrado', 1], ['16:9', '16:9', 16 / 9], ['4:3', '4:3', 4 / 3], ['3:2', '3:2', 3 / 2], ['5:4', '5:4', 5 / 4], ['9:16', '9:16', 9 / 16], ['3:4', '3:4', 3 / 4], ['2:3', '2:3', 2 / 3], ['4:5', '4:5', 4 / 5]];
// girar 90° inverte a proporção em pixels: o rótulo vira junto (16:9 → 9:16), como no iOS
const INVERSE = { '16:9': '9:16', '9:16': '16:9', '4:3': '3:4', '3:4': '4:3', '3:2': '2:3', '2:3': '3:2', '5:4': '4:5', '4:5': '5:4' };

const blank = () => ({ ...Object.fromEntries(KEYS.map(k => [k, 0])), filter: 'none', filterAmt: 100, rot: 0, flip: false, angle: 0, crop: [0, 0, 1, 1], aspect: 'free', auto: false, autoBase: null, trim: null, mute: false });

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
  if (!gl) return null; // GPU bloqueada, driver ruim ou limite de contextos
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

/** proporção travada em inteiros (16:9 → [16, 9]) para o arquivo sair com a razão exata */
function aspectPair(k, ow, oh) {
  if (k === '1') return [1, 1];
  if (k.includes(':')) return k.split(':').map(Number);
  if (k === 'orig') {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const g = gcd(ow, oh);
    if (ow / g <= 64 && oh / g <= 64) return [ow / g, oh / g];
  }
  return null;
}

// o segmented (ui.js) registra um pointerup global que nunca sai: o callback das abas passa por
// aqui, fora do escopo do editor, para não prender o editor inteiro (foto em resolução cheia) na memória
const hookOf = holder => v => holder.fn?.(v);

/** espera um evento de mídia; erro, aborto ou src removido resolvem com false */
const mediaEvent = (m, ok) => new Promise(r => {
  const end = v => () => { m.removeEventListener(ok, yes); ['error', 'abort', 'emptied'].forEach(e => m.removeEventListener(e, no)); r(v); };
  const yes = end(true), no = end(false);
  m.addEventListener(ok, yes, { once: true });
  ['error', 'abort', 'emptied'].forEach(e => m.addEventListener(e, no, { once: true }));
});

// ---------- editor ----------
export async function openEditor(it, onDone) {
  // duplo clique em "Editar" chamaria duas vezes antes do primeiro terminar de carregar
  if (document.querySelector('.editor:not(.out)')) return;
  const prev = S.data.edits[it.id];
  const st = { ...blank(), ...(prev || {}) };
  delete st.v;
  delete st.ext; // o formato da cópia não é um ajuste: com ele aqui, "Reverter" + Concluído nunca ficava limpo
  if (st.sharpness < 0) st.sharpness = 0; // a régua da nitidez começa no 0 (negativo não tinha efeito)
  const start = JSON.stringify(st);

  let tab = 'adjust', tool = 'exposure', showOrig = false;
  let raf = 0, exporting = false, busy = false, ready = false, closed = false;
  let disp = { w: 1, h: 1 }; // tamanho final do canvas na tela (o CSS anima até ele)
  let doneBtn = null, ro = null, tabs = null, audio = null, stripVideo = null, video = null;
  const tabHook = { fn: null };
  const ac = new AbortController(); // todos os listeners globais saem juntos no close()
  const on = (t, type, fn, opt) => t.addEventListener(type, fn, { ...opt, signal: ac.signal });

  // o palco (com o indicador) e o botão de sair entram já no carregamento: foto grande ou vídeo
  // travado não deixam mais uma tela preta sem saída
  const canvas = h('canvas.e-canvas');
  canvas.style.opacity = '0';
  const loading = h('div.e-loading', h('div.spin'));
  const stage = h('div.e-stage', canvas, loading);
  const el = h('div.editor');
  const loadTop = h('div.e-top', h('div.pill.glass.dim', h('button.gbtn.round', { title: 'Cancelar (Esc)', onclick: () => abortLoad() }, icon('close'))));
  el.append(stage, loadTop);
  document.body.append(el);
  let wake = null; // acorda a espera do carregamento quando o usuário cancela
  function abortLoad(msg) {
    if (closed) return;
    closed = true;
    ac.abort();
    wake?.(false);
    if (video) { video.removeAttribute('src'); video.load(); }
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
    if (msg) toast(msg, 'info');
  }

  const onKey = e => {
    if (!ready) {
      if (e.key === 'Escape') { e.stopPropagation(); abortLoad(); }
      return;
    }
    if (document.querySelector('.alert')) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (exporting === true) exporting = 'cancel';
      else if (!busy) cancel();
    } else if (busy) {
      // salvando: Enter/Espaço não podem gravar de novo nem pausar o vídeo que está sendo gravado
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); }
    } else if (e.key === ' ' && isVideo && !e.target.closest?.('input')) { e.preventDefault(); e.stopPropagation(); togglePlay(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (!e.repeat) finish(); }
  };
  on(document, 'keydown', onKey, { capture: true });

  let G = null;
  try { G = glSetup(canvas); } catch (e) { console.error(e); }
  if (!G) return abortLoad('Não foi possível iniciar o editor (WebGL indisponível)');
  const { gl } = G;
  let { u } = G;

  // fonte: a foto (pela tela 2D, que aplica a orientação EXIF) ou o próprio vídeo, quadro a quadro
  const isVideo = !!it.video;
  let srcEl = null, srcW, srcH, reducedFrom = 0;
  if (isVideo) {
    video = h('video', { playsInline: true, preload: 'auto' });
    video.crossOrigin = 'anonymous';
    video.muted = !!st.mute;
    video.src = fullUrl(it);
    const ok = await new Promise(res => {
      const t = setTimeout(() => res(false), 20000); // arquivo travado: nem loadeddata nem error
      wake = v => { clearTimeout(t); res(v); };
      mediaEvent(video, 'loadeddata').then(wake);
    });
    wake = null;
    if (closed) return;
    if (!ok) return abortLoad('Não foi possível abrir este vídeo para edição');
    srcEl = video;
    srcW = video.videoWidth;
    srcH = video.videoHeight;
  } else {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => res(i);
      i.onerror = rej;
      wake = () => res(null);
      i.src = fullUrl(it);
    }).catch(() => null);
    wake = null;
    if (closed) return;
    if (!img) return abortLoad('Não foi possível abrir esta foto para edição');
    const maxT = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    const big = Math.max(img.naturalWidth, img.naturalHeight);
    const sc = Math.min(1, maxT / big);
    if (sc < 1) reducedFrom = big;
    srcW = Math.round(img.naturalWidth * sc);
    srcH = Math.round(img.naturalHeight * sc);
    const c2 = document.createElement('canvas');
    c2.width = srcW;
    c2.height = srcH;
    const x2 = c2.getContext('2d');
    x2.fillStyle = '#fff'; // PNG transparente: a textura é RGB e o transparente viraria preto
    x2.fillRect(0, 0, srcW, srcH);
    x2.drawImage(img, 0, 0, srcW, srcH);
    srcEl = c2;
  }
  let tex = null;
  const upload = () => srcEl && gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, srcEl);
  function initTex() {
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    upload();
  }
  initTex();
  loading.remove();

  // perda do contexto (reset do driver, suspensão): a prévia fica preta e salvar gravaria um JPEG preto.
  // Bloqueia o Concluído até o navegador devolver o contexto e então refaz programa e textura.
  const lostBox = h('div.e-export.glass', h('b', 'Recuperando o editor'), h('span', 'A placa de vídeo foi reiniciada. Suas alterações continuam aqui.'));
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault(); // sem isto o navegador nunca devolve o contexto
    if (closed) return;
    stage.append(lostBox);
    if (doneBtn) doneBtn.disabled = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (closed) return;
    try {
      u = glSetup(canvas).u;
      initTex();
    } catch (e) {
      console.error(e);
      return;
    }
    lostBox.remove();
    if (doneBtn) doneBtn.disabled = false;
    if (tab === 'filters') buildFilters();
    render();
  });

  function oriented() { return st.rot % 2 ? [srcH, srcW] : [srcW, srcH]; }

  function draw(w, hgt, { full = false, orig = false } = {}) {
    if (gl.isContextLost()) return;
    // mudar o tamanho do canvas (mesmo para o mesmo valor) recria o buffer: só quando muda
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== hgt) canvas.height = hgt;
    if (isVideo) upload();
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
  function render() {
    if (exporting || closed || !ready) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (exporting || closed) return;
      const full = tab === 'crop';
      const [ow, oh] = oriented();
      const cw = full ? ow : ow * st.crop[2], ch = full ? oh : oh * st.crop[3];
      const W = stage.clientWidth - 80, H = stage.clientHeight - 60;
      const s = Math.min(W / cw, H / ch);
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const dw = Math.max(1, Math.round(cw * s)), dh = Math.max(1, Math.round(ch * s));
      disp = { w: dw, h: dh };
      canvas.style.width = dw + 'px';
      canvas.style.height = dh + 'px';
      canvas.style.opacity = '';
      draw(Math.min(Math.round(dw * dpr), 4096), Math.min(Math.round(dh * dpr), 4096), { full, orig: showOrig });
      if (full) placeCrop();
    });
  }

  // ---------- barra superior ----------
  doneBtn = h('button.gbtn.round.e-done', { title: 'Concluído (Enter)', onclick: finish }, icon('check'));
  if (gl.isContextLost()) doneBtn.disabled = true;
  const top = h('div.e-top',
    h('div.pill.glass.dim', h('button.gbtn.round', { title: 'Cancelar (Esc)', onclick: () => { if (exporting === true) exporting = 'cancel'; else if (!busy) cancel(); } }, icon('close'))),
    h('div.e-title', isVideo ? 'Editar Vídeo' : 'Editar'),
    h('div.pill.glass.dim', h('button.gbtn', { title: 'Restaurar tudo', onclick: () => { if (busy) return; Object.assign(st, blank()); syncAll(); } }, 'Reverter')),
    h('div.pill.glass.dim', doneBtn));

  // comparar: segurar o clique na foto mostra o original
  stage.addEventListener('pointerdown', e => {
    if (tab === 'crop' || e.button !== 0 || busy) return;
    if (tab === 'video') return togglePlay();
    showOrig = true;
    stage.classList.add('orig');
    render();
  });
  const endOrig = () => {
    if (!showOrig) return;
    showOrig = false;
    stage.classList.remove('orig');
    render();
  };
  // ponteiro cancelado ou janela trocada no meio do clique também soltam o "ORIGINAL"
  on(window, 'pointerup', endOrig);
  on(window, 'pointercancel', endOrig);
  on(window, 'blur', endOrig);

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
    const end = () => { d = null; r.classList.remove('drag'); };
    r.addEventListener('pointerdown', e => { d = { x: e.clientX, v: get() }; r.setPointerCapture(e.pointerId); r.classList.add('drag'); });
    r.addEventListener('pointermove', e => {
      if (!d) return;
      let v = d.v - (e.clientX - d.x) / ppu;
      v = Math.max(min, Math.min(max, v));
      if (Math.abs(v) < 1.2) v = 0;
      set(v);
      upd();
    });
    r.addEventListener('pointerup', end);
    r.addEventListener('pointercancel', end);
    r.addEventListener('lostpointercapture', end);
    r.addEventListener('dblclick', () => { set(0); upd(); });
    r.addEventListener('wheel', e => { e.preventDefault(); set(Math.max(min, Math.min(max, get() - Math.sign(e.deltaY || e.deltaX) * 2))); upd(); }, { passive: false });
    const layout = () => {
      ticks.style.setProperty('--min', min * ppu + 'px');
      ticks.style.width = (max - min) * ppu + 'px';
      ticks.style.left = `calc(50% + ${min * ppu}px)`;
    };
    r.range = (a, b) => { min = a; max = b; layout(); upd(); };
    layout();
    r.upd = upd;
    upd();
    return r;
  }

  // ---------- Ajustar ----------
  const toolBtns = new Map();
  const adjRuler = ruler(() => (tool === 'auto' ? 0 : st[tool]), v => {
    if (tool === 'auto') return;
    st[tool] = v;
    // mexer à mão encerra o Auto mantendo os valores atuais
    if (st.auto) { st.auto = false; st.autoBase = null; paintBtn('auto'); }
    render();
    paintBtn(tool);
  }, -100, 100);
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
      if (!st.auto) {
        // guarda os valores do usuário: desligar o Auto devolve eles, em vez de zerar
        st.autoBase = Object.fromEntries(AUTO_KEYS.map(key => [key, st[key]]));
        st.auto = true;
        autoEnhance();
      } else {
        Object.assign(st, st.autoBase || Object.fromEntries(AUTO_KEYS.map(key => [key, 0])));
        st.auto = false;
        st.autoBase = null;
      }
      ADJ.forEach(a => paintBtn(a[0]));
      render();
    }
    tool = k;
    toolBtns.forEach((b, key) => b.classList.toggle('on', key === k));
    toolName.textContent = ADJ.find(a => a[0] === k)[1].toUpperCase();
    adjRuler.classList.toggle('hidden', k === 'auto');
    if (k !== 'auto') adjRuler.range(POSITIVE.has(k) ? 0 : -100, 100);
    adjRuler.upd();
    toolBtns.get(k).scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' });
  }
  function autoEnhance() {
    if (gl.isContextLost()) return; // sem contexto o histograma viria todo preto
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
    // durante a exportação o canvas é o que está sendo gravado; sem contexto as miniaturas sairiam pretas
    if (exporting || gl.isContextLost()) return;
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
      h('div.pill.glass.dim', h('button.gbtn.round', { title: 'Girar 90°', onclick: rotate }, icon('rotate')), h('button.gbtn.round', { title: 'Espelhar', onclick: flip }, icon('flip'))),
      aspectRow,
      h('div.pill.glass.dim', h('button.gbtn', { onclick: () => {
        // como no iOS: volta toda a geometria, inclusive giro e espelho
        Object.assign(st, { crop: [0, 0, 1, 1], angle: 0, aspect: 'free', rot: 0, flip: false });
        straight.upd(); markAspect(); render();
      } }, 'Redefinir'))));

  function rotate() {
    // anti-horário, como no iOS. O espelho é aplicado por último no shader: com ele ligado, a
    // imagem por baixo precisa girar no sentido oposto para a tela girar anti-horário
    st.rot = (st.rot + (st.flip ? 1 : 3)) % 4;
    const [x, y, w, hh] = st.crop;
    st.crop = [y, 1 - x - w, hh, w];
    if (INVERSE[st.aspect]) { st.aspect = INVERSE[st.aspect]; markAspect(); }
    render();
  }
  function flip() {
    st.flip = !st.flip;
    // o espelho vale para tudo que está na tela: o recorte e o endireitar viram junto
    st.crop = [1 - st.crop[0] - st.crop[2], st.crop[1], st.crop[2], st.crop[3]];
    st.angle = -st.angle;
    straight.upd();
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
    // pelo tamanho final do canvas, não pelo medido: ele anima por 0,3 s (girar, trocar de aba,
    // redimensionar) e a medida viria no meio da transição. O palco centraliza o canvas.
    const ox = (stage.clientWidth - disp.w) / 2, oy = (stage.clientHeight - disp.h) / 2;
    const [x, y, w, hh] = st.crop;
    Object.assign(cropBox.style, { left: ox + x * disp.w + 'px', top: oy + y * disp.h + 'px', width: w * disp.w + 'px', height: hh * disp.h + 'px' });
  }
  let cd = null;
  cropBox.addEventListener('pointerdown', e => {
    e.stopPropagation();
    cd = { k: e.target.dataset.k || 'move', x: e.clientX, y: e.clientY, c: [...st.crop], r: { ...disp } };
    cropBox.setPointerCapture(e.pointerId);
    cropBox.classList.add('drag');
  });
  cropBox.addEventListener('pointermove', e => {
    if (!cd) return;
    const dx = (e.clientX - cd.x) / cd.r.w, dy = (e.clientY - cd.y) / cd.r.h;
    let [x, y, w, hh] = cd.c;
    const min = 0.06, k = cd.k;
    if (k === 'move') {
      x = Math.max(0, Math.min(1 - w, x + dx));
      y = Math.max(0, Math.min(1 - hh, y + dy));
    } else {
      const x2 = x + w, y2 = y + hh, cx = x + w / 2, cy = y + hh / 2;
      let nx = x, nx2 = x2, ny = y, ny2 = y2;
      if (k.includes('w')) nx = Math.max(0, Math.min(x2 - min, x + dx));
      if (k.includes('e')) nx2 = Math.min(1, Math.max(x + min, x2 + dx));
      if (k.includes('n')) ny = Math.max(0, Math.min(y2 - min, y + dy));
      if (k.includes('s')) ny2 = Math.min(1, Math.max(y + min, y2 + dy));
      const r = ratioOf(st.aspect);
      if (!r) {
        [x, y, w, hh] = [nx, ny, nx2 - nx, ny2 - ny];
      } else {
        // proporção travada: um lado manda e o outro sai da razão. O lado oposto à alça fica
        // ancorado e o limite vale para os dois lados (antes só um era cortado em 1 e a razão quebrava)
        const [ow, oh] = oriented();
        const q = ow / (r * oh); // altura normalizada por unidade de largura
        const horiz = /[ew]/.test(k), vert = /[ns]/.test(k);
        const byW = horiz && (!vert || Math.abs(dx * cd.r.w) >= Math.abs(dy * cd.r.h));
        let nw = byW ? nx2 - nx : (ny2 - ny) / q;
        const maxW = k.includes('e') ? 1 - x : k.includes('w') ? x2 : 1;
        const maxH = k.includes('s') ? 1 - y : k.includes('n') ? y2 : 1;
        nw = Math.min(Math.max(nw, min, min / q), maxW, maxH / q);
        w = nw;
        hh = nw * q;
        x = k.includes('e') ? x : k.includes('w') ? x2 - w : Math.max(0, Math.min(1 - w, cx - w / 2));
        y = k.includes('s') ? y : k.includes('n') ? y2 - hh : Math.max(0, Math.min(1 - hh, cy - hh / 2));
      }
    }
    st.crop = [x, y, w, hh];
    placeCrop();
  });
  const endCrop = () => { cd = null; cropBox.classList.remove('drag'); };
  cropBox.addEventListener('pointerup', endCrop);
  cropBox.addEventListener('pointercancel', endCrop);
  cropBox.addEventListener('lostpointercapture', endCrop);

  // ---------- Vídeo: aparar início/fim, sem som, tocar ----------
  // WebM sem duração no cabeçalho dá Infinity: sem duração válida a faixa fica desligada
  const dur = isVideo ? [video.duration, it.dur].find(d => Number.isFinite(d) && d > 0) || 0 : 0;
  const trimOf = () => st.trim || [0, dur || Infinity];
  let videoPane = h('div.e-pane.hidden');
  let paintTrim = () => {}, paintMute = () => {};
  function togglePlay() {
    if (!isVideo || busy) return;
    if (video.paused) {
      const [a, b] = trimOf();
      if (video.currentTime < a || video.currentTime >= b - 0.05) video.currentTime = a;
      audio?.actx.resume().catch(() => {}); // o som da prévia passa pelo AudioContext depois da 1ª exportação
      video.play().catch(() => {});
    } else video.pause();
  }
  if (isVideo) {
    const playBtn = h('button.gbtn.round', { title: 'Reproduzir (Espaço)', onclick: togglePlay }, icon('play'));
    const muteBtn = h('button.gbtn.round', { title: 'Som', onclick: () => { st.mute = !st.mute; video.muted = st.mute; paintMute(); } });
    paintMute = () => {
      muteBtn.replaceChildren(icon(st.mute ? 'mute' : 'speaker'));
      muteBtn.classList.toggle('on', st.mute);
      muteBtn.title = st.mute ? 'Sem som (o vídeo salvo fica mudo)' : 'Com som';
    };
    paintMute();
    video.addEventListener('play', () => playBtn.replaceChildren(icon('pause')));
    video.addEventListener('pause', () => playBtn.replaceChildren(icon('play')));
    const frames = h('div.vt-frames');
    const dimL = h('div.vt-dim'), dimR = h('div.vt-dim');
    const sel = h('div.vt-sel', h('div.vt-h', { dataset: { k: 'a' } }), h('div.vt-h', { dataset: { k: 'b' } }));
    const headEl = h('div.vt-head');
    const strip = h('div.vt-strip', frames, dimL, dimR, sel, headEl);
    const info = h('div.vt-info');
    const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    paintTrim = () => {
      if (!dur) { info.textContent = ''; return; }
      const [a, b] = trimOf();
      const pa = (a / dur) * 100, pb = (b / dur) * 100;
      dimL.style.cssText = `left:0;width:${pa}%`;
      dimR.style.cssText = `left:${pb}%;right:0`;
      sel.style.cssText = `left:${pa}%;width:${pb - pa}%`;
      headEl.style.left = (video.currentTime / dur) * 100 + '%';
      info.textContent = st.trim ? `${fmt(b - a)} de ${fmt(dur)}` : fmt(dur);
    };
    const minTrim = Math.min(0.5, dur); // vídeo com menos de 0,5 s deixava o trecho negativo
    let td = null;
    strip.addEventListener('pointerdown', e => {
      if (!dur) return;
      const r = strip.getBoundingClientRect();
      td = { k: e.target.dataset.k || 'seek', r };
      strip.setPointerCapture(e.pointerId);
      video.pause();
      strip.dispatchEvent(new PointerEvent('pointermove', e));
    });
    strip.addEventListener('pointermove', e => {
      if (!td) return;
      const t = Math.max(0, Math.min(dur, ((e.clientX - td.r.left) / td.r.width) * dur));
      let [a, b] = trimOf();
      if (td.k === 'a') a = Math.max(0, Math.min(t, b - minTrim));
      else if (td.k === 'b') b = Math.min(dur, Math.max(t, a + minTrim));
      if (td.k !== 'seek') {
        st.trim = a <= 0.05 && b >= dur - 0.05 ? null : [a, b];
        video.currentTime = td.k === 'a' ? a : b;
      } else video.currentTime = Math.max(a, Math.min(b, t));
      paintTrim();
    });
    const endTrim = () => (td = null);
    strip.addEventListener('pointerup', endTrim);
    strip.addEventListener('pointercancel', endTrim);
    strip.addEventListener('lostpointercapture', endTrim);
    videoPane = h('div.e-pane', h('div.e-toolname', 'VÍDEO'),
      h('div.vt-row', h('div.pill.glass.dim', playBtn), strip, h('div.pill.glass.dim', muteBtn)), info);
    // quadros da faixa: um segundo vídeo, mudo, pulando pelos pontos. Para se o editor fechar.
    (async () => {
      if (!dur) return;
      const fv = stripVideo = h('video', { muted: true, preload: 'auto' });
      fv.crossOrigin = 'anonymous';
      try {
        const loaded = mediaEvent(fv, 'loadeddata');
        fv.src = video.currentSrc;
        if (!(await loaded) || closed) return;
        const n = 12, c = document.createElement('canvas');
        c.height = 96;
        c.width = Math.max(32, Math.round((96 * srcW) / srcH));
        for (let i = 0; i < n; i++) {
          const seeked = mediaEvent(fv, 'seeked');
          fv.currentTime = ((i + 0.5) * dur) / n;
          if (!(await seeked) || closed) return;
          c.getContext('2d').drawImage(fv, 0, 0, c.width, c.height);
          frames.append(h('img', { src: c.toDataURL('image/jpeg', 0.7), draggable: false }));
        }
      } finally {
        fv.removeAttribute('src');
        fv.load();
        stripVideo = null;
      }
    })();
    // prévia: cada quadro novo passa pelo WebGL; o trecho aparado toca em laço.
    // Durante a exportação quem manda é a exportação: o laço não pode voltar o vídeo ao início.
    const onFrame = () => {
      if (closed) return;
      if (!exporting) {
        const [a, b] = trimOf();
        if (!video.paused && video.currentTime >= b) video.currentTime = a;
        render();
        paintTrim();
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.addEventListener('seeked', () => { if (!exporting) { render(); paintTrim(); } });
    // o fim natural pausa o vídeo: sem isto o laço só funcionava com o fim aparado
    video.addEventListener('ended', () => {
      if (exporting || closed) return;
      video.currentTime = trimOf()[0];
      video.play().catch(() => {});
    });
    paintTrim();
  }

  // ---------- abas ----------
  tabHook.fn = v => setTab(v);
  tabs = segmented([...(isVideo ? [{ value: 'video', label: 'Vídeo' }] : []), { value: 'adjust', label: 'Ajustar' }, { value: 'filters', label: 'Filtros' }, { value: 'crop', label: 'Cortar' }], tab, hookOf(tabHook));
  tabs.classList.add('dim');
  function setTab(v) {
    if (busy) return;
    tab = v;
    videoPane.classList.toggle('hidden', v !== 'video');
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
    // Reverter também zera o trecho e o som: a faixa, o ícone e a prévia acompanham
    if (video) video.muted = !!st.mute;
    paintMute();
    paintTrim();
    if (tab === 'filters') buildFilters();
    render();
  }

  const bottom = h('div.e-bottom', videoPane, adjustPane, filterPane, cropPane, h('div.e-tabs', tabs));
  loadTop.remove();
  el.append(top, bottom);
  ready = true;
  if (isVideo) {
    tabs.set('video');
    setTab('video');
  }
  pickTool('exposure');
  ADJ.forEach(a => paintBtn(a[0]));
  render();
  ro = new ResizeObserver(render);
  ro.observe(stage);
  // reforço: quando a animação de tamanho do canvas termina, a caixa de corte confere a posição
  canvas.addEventListener('transitionend', () => { if (tab === 'crop') placeCrop(); });

  /** trava a interface enquanto salva: nada pode mexer no st nem no canvas que está sendo gravado */
  function lockUI(v) {
    for (const x of [stage, top, bottom]) x.inert = v;
    el.classList.toggle('e-busy', v);
  }

  function close() {
    if (closed) return;
    closed = true;
    ac.abort();
    ro?.disconnect();
    cancelAnimationFrame(raf);
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (stripVideo) { stripVideo.removeAttribute('src'); stripVideo.load(); }
    audio?.actx.close().catch(() => {});
    audio = null;
    el.classList.add('out');
    setTimeout(() => {
      el.remove();
      // só depois do fade: antes disso o canvas ficava preto durante a saída
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      // a foto em resolução cheia sai da memória mesmo que algo ainda segure o editor
      if (srcEl && srcEl !== video) srcEl.width = srcEl.height = 0;
      srcEl = null;
      // o segmented continua preso ao pointerup global do ui.js: solto da árvore, não segura o resto
      tabHook.fn = null;
      tabs?.remove();
    }, 300);
  }
  async function cancel() {
    if (busy) return;
    if (JSON.stringify(st) !== start && !(await confirmBox('Descartar alterações?', '', 'Descartar'))) return;
    close();
  }
  async function finish() {
    // Enter repetido ou duplo clique não podem gravar (nem exportar) duas vezes
    if (busy || closed || !ready) return;
    if (JSON.stringify(st) === start) return close();
    const b0 = blank();
    const clean = Object.keys(b0).every(k => k === 'auto' || k === 'autoBase' || JSON.stringify(st[k]) === JSON.stringify(b0[k]));
    if (!clean && gl.isContextLost()) return toast('O editor está se recuperando de um erro da placa de vídeo. Tente de novo em instantes.', 'info');
    busy = true;
    lockUI(true);
    try {
      if (clean) {
        // vídeo ou foto de volta ao original: apaga a cópia em vez de gerar outra igual ao original
        await api.deleteRender(it.id);
        delete S.data.edits[it.id];
      } else if (!(isVideo ? await exportVideo() : await savePhoto())) return;
      save();
      close();
      onDone?.();
    } catch (e) {
      toast('Erro ao salvar: ' + (e?.message || e), 'info');
    } finally {
      busy = false;
      if (!closed) { lockUI(false); render(); }
    }
  }

  /** tamanho do arquivo; com proporção travada sai com a razão exata (múltiplo do par inteiro) */
  function outSize() {
    const [ow, oh] = oriented();
    let w = Math.max(1, Math.round(ow * st.crop[2])), hh = Math.max(1, Math.round(oh * st.crop[3]));
    const r = ratioOf(st.aspect), p = r && aspectPair(st.aspect, ow, oh);
    if (p) {
      const n = Math.max(1, Math.round(w / p[0]));
      w = n * p[0];
      hh = n * p[1];
    } else if (r) hh = Math.max(1, Math.round(w / r));
    return [w, hh];
  }

  async function savePhoto() {
    let [w, hh] = outSize();
    draw(w, hh);
    // o Chromium reduz o buffer em silêncio quando não consegue alocar: salva menor, mas inteiro
    let reduced = reducedFrom;
    if (!gl.isContextLost() && (gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== hh)) {
      const k = Math.min(gl.drawingBufferWidth / w, gl.drawingBufferHeight / hh);
      w = Math.max(1, Math.floor(w * k));
      hh = Math.max(1, Math.floor(hh * k));
      draw(w, hh);
      reduced = reduced || 1;
    }
    // contexto perdido não desenha nada e o JPEG sairia preto. O shader sempre escreve alfa 255,
    // então um pixel com alfa diferente denuncia o buffer vazio.
    const px = new Uint8Array(4);
    if (!gl.isContextLost()) gl.readPixels(w >> 1, hh >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (gl.isContextLost() || px[3] !== 255) {
      toast('Não foi possível gerar a foto editada (erro da placa de vídeo). Nada foi salvo.', 'info');
      return false;
    }
    const data = canvas.toDataURL('image/jpeg', 0.93);
    if (gl.isContextLost()) {
      toast('Não foi possível gerar a foto editada (erro da placa de vídeo). Nada foi salvo.', 'info');
      return false;
    }
    await api.saveRender(it.id, data);
    S.data.edits[it.id] = { ...st, v: Date.now().toString(36) };
    if (reduced) toast(`A cópia editada foi salva com ${w}×${hh} px (limite da placa de vídeo).`, 'info');
    return true;
  }

  /** grafo de som criado uma única vez: createMediaElementSource só pode ser chamado uma vez por <video> */
  function audioGraph() {
    if (!audio) {
      const actx = new AudioContext();
      const node = actx.createMediaElementSource(video);
      node.connect(actx.destination);
      audio = { actx, node };
    }
    return audio;
  }

  /** tamanho do vídeo: até 4K (em pixels totais, para caber no nível 5.1 do H.264), lados pares */
  function videoSize() {
    let [w, hh] = outSize();
    const k = Math.min(1, 3840 / Math.max(w, hh), Math.sqrt((3840 * 2160) / (w * hh)));
    const [ow, oh] = oriented();
    const p = ratioOf(st.aspect) && aspectPair(st.aspect, ow, oh);
    if (p) {
      const step = p[0] % 2 || p[1] % 2 ? 2 : 1;
      const n = Math.max(step, Math.round((w * k) / p[0] / step) * step);
      return [n * p[0], n * p[1]];
    }
    w = Math.max(2, Math.round((w * k) / 2) * 2);
    hh = Math.max(2, Math.round((hh * k) / 2) * 2);
    return [w, hh];
  }

  /**
   * Exporta o vídeo editado: toca o trecho aparado em tempo real, desenha cada quadro com os ajustes
   * no canvas e grava canvas + som com o MediaRecorder (MP4 H.264/AAC quando o WebView2 suporta).
   */
  async function exportVideo() {
    const [a, b] = trimOf();
    const [w, hh] = videoSize();
    // nível do H.264 pelo tamanho do quadro a 30 fps: 4.0 vai até ~1080p e recusava 4K (arquivo vazio)
    const mbs = Math.ceil(w / 16) * Math.ceil(hh / 16);
    const lvl = mbs <= 8192 ? '640028' : mbs <= 19660 ? '640032' : '640033';
    const mime = [`video/mp4;codecs=avc1.${lvl},mp4a.40.2`, 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
      .find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!mime) {
      toast('Este Windows não consegue gravar vídeo', 'info');
      return false;
    }
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const bar = h('i');
    const label = h('span', 'Preparando…');
    const cancelBtn = h('button.gbtn', { onclick: () => { if (exporting === true) exporting = 'cancel'; } }, 'Cancelar');
    const box = h('div.e-export.glass', h('b', 'Salvando vídeo'), label, h('div.e-exbar', bar), cancelBtn);
    el.append(box);
    exporting = true;
    const stops = []; // faixas paradas no fim (a câmera do canvas e o som seguiam vivas)
    let ag = null, silent = false;
    try {
      video.pause();
      draw(w, hh);
      if (gl.isContextLost() || gl.drawingBufferWidth !== w || gl.drawingBufferHeight !== hh) {
        toast('A placa de vídeo não conseguiu preparar um quadro desse tamanho. Tente um recorte menor.', 'info');
        return false;
      }
      const tracks = [...canvas.captureStream(30).getVideoTracks()];
      stops.push(...tracks);
      if (!st.mute) {
        try {
          // o som vai só para a gravação (não toca nas caixas durante a exportação)
          ag = audioGraph();
          const dest = ag.actx.createMediaStreamDestination();
          ag.node.disconnect();
          ag.node.connect(dest);
          const at = dest.stream.getAudioTracks();
          tracks.push(...at);
          stops.push(...at);
          video.muted = false;
        } catch (e) {
          console.warn(e);
          ag = null;
          silent = true;
        }
      }
      const rec = new MediaRecorder(new MediaStream(tracks), {
        mimeType: mime,
        videoBitsPerSecond: Math.min(60e6, Math.round(w * hh * 30 * 0.17)),
        audioBitsPerSecond: 192000,
      });
      const chunks = [];
      let recError = '';
      rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      rec.onerror = e => { recError = 'O gravador de vídeo falhou' + (e.error?.message ? ` (${e.error.message})` : '') + '.'; };
      const stopped = new Promise(r => (rec.onstop = r));
      const seeked = Promise.race([mediaEvent(video, 'seeked'), new Promise(r => setTimeout(r, 5000))]);
      video.currentTime = a;
      await seeked;
      if (exporting === 'cancel' || closed) return false;
      draw(w, hh);
      const poster = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
      // o canal de áudio começa suspenso; sem retomar, o vídeo não anda e a gravação nunca termina
      if (ag && ag.actx.state !== 'running') await ag.actx.resume().catch(() => {});
      rec.start(1000);
      let played = await video.play().then(() => true, () => false);
      if (!played && !video.muted) {
        video.muted = true; // sem permissão para tocar com som: grava pelo menos a imagem (e avisa)
        silent = true;
        played = await video.play().then(() => true, () => false);
      }
      let problem = played ? '' : 'O vídeo não começou a tocar.';
      await new Promise(resolve => {
        let lastT = -1, lastMove = performance.now(), done = false, away = false;
        const end = () => {
          if (done) return;
          done = true;
          clearInterval(watch);
          document.removeEventListener('visibilitychange', vis);
          resolve();
        };
        const step = t => {
          if (done) return;
          if (gl.isContextLost()) { problem = 'A placa de vídeo foi reiniciada durante a gravação.'; return end(); }
          draw(w, hh);
          const cur = t ?? video.currentTime;
          const p = Math.max(0, Math.min(1, (cur - a) / Math.max(0.1, b - a)));
          bar.style.width = p * 100 + '%';
          label.textContent = `${Math.round(p * 100)}% — o vídeo toca uma vez enquanto é salvo`;
          if (exporting === 'cancel' || recError || closed || video.ended || cur >= b - 0.02) end();
        };
        // mediaTime é o tempo do quadro entregue: mais confiável que currentTime para achar o fim
        const tick = (_, md) => { step(md?.mediaTime); if (!done) video.requestVideoFrameCallback(tick); };
        video.requestVideoFrameCallback(tick);
        video.addEventListener('ended', end, { once: true });
        // janela minimizada/coberta: o WebView2 para os quadros e o arquivo sairia travado.
        // Pausa vídeo e gravação até a janela voltar.
        const vis = () => {
          if (done) return;
          if (document.hidden) {
            away = true;
            video.pause();
            if (rec.state === 'recording') rec.pause();
            label.textContent = 'Pausado — volte para esta janela para continuar';
          } else if (away) {
            away = false;
            if (rec.state === 'paused') rec.resume();
            video.play().catch(() => {});
            lastMove = performance.now();
          }
        };
        document.addEventListener('visibilitychange', vis);
        // vigia: se o vídeo parar de andar, termina com o que já foi gravado (ou avisa)
        const watch = setInterval(() => {
          if (away) { lastMove = performance.now(); return; }
          if (exporting === 'cancel' || recError || closed) return end();
          if (video.currentTime !== lastT) { lastT = video.currentTime; lastMove = performance.now(); step(); return; }
          if (video.paused && played) video.play().catch(() => {});
          if (performance.now() - lastMove > 4000) {
            if ((video.currentTime - a) / Math.max(0.1, b - a) < 0.9) problem = 'O vídeo parou de tocar durante a gravação.';
            end();
          }
        }, 500);
        if (!played) end();
      });
      video.pause();
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      if (exporting === 'cancel' || closed) return false;
      if (recError && !problem) problem = recError;
      if (problem) {
        toast(problem + ' Tente de novo.', 'info');
        return false;
      }
      // daqui em diante só grava o arquivo: Esc e Cancelar não interrompem no meio
      exporting = 'saving';
      cancelBtn.remove();
      label.textContent = 'Gravando o arquivo…';
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 1024) {
        toast('A gravação saiu vazia (o codificador de vídeo falhou). Nada foi salvo.', 'info');
        return false;
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try {
        if (poster) await api.saveRenderPoster(it.id, new Uint8Array(await poster.arrayBuffer()));
        await api.saveRenderVideo(it.id, ext, bytes);
      } catch (e) {
        toast('Erro ao salvar o vídeo: ' + (e?.message || e), 'info');
        return false;
      }
      S.data.edits[it.id] = { ...st, v: Date.now().toString(36), ext };
      if (silent) toast('O vídeo foi salvo sem som: o Windows não deixou tocar o som durante a gravação.', 'info');
      return true;
    } finally {
      exporting = false;
      stops.forEach(t => t.stop());
      if (ag && audio === ag) {
        // a prévia volta a ter som pelo mesmo nó (não dá para criar outro para este <video>)
        try { ag.node.disconnect(); } catch {}
        ag.node.connect(ag.actx.destination);
      }
      if (video) video.muted = !!st.mute;
      box.remove();
    }
  }
}
