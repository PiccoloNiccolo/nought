// PnL share card: one coin's result drawn on a 1200×675 canvas in this browser (nothing is uploaded anywhere).
// openPnlCard({mint, symbol, image, investedSol, soldSol, pnlSol, pnlPct, pnlUsd}) opens a dialog with a live preview,
// a custom background (a local image file), colour pickers, Download PNG and Copy image (ClipboardItem; when the browser
// can't copy images the PNG is downloaded instead). The token picture is loaded with CORS; if it fails or would taint
// the canvas, the card draws the ticker's initials instead so export always works. Colours are kept in this browser.
import { short, toast, LS, safeUrl, esc, ICON } from '../core/util.js';
import { imgFallback } from '../core/meta.js';

const W = 1200, H = 675;
const SANS = '"Geist", ui-sans-serif, system-ui, sans-serif', MONO = '"Geist Mono", ui-monospace, Menlo, monospace';
const DEF = { bg: '#07080b', up: '#2fd38b', down: '#ff5d6c', fg: '#e7e9ef', usd: true };
const HEX = /^#[0-9a-f]{6}$/i, BRAND = '#38d6f5';
let bg = null; // the uploaded background {img, url}: kept for this tab only, never stored or sent

function loadStyle() {
  const s = { ...DEF, ...(LS.get('pnlcard.style', {}) || {}) };
  for (const k of ['bg', 'up', 'down', 'fg']) if (!HEX.test(s[k])) s[k] = DEF[k];
  s.usd = s.usd !== false;
  return s;
}
const rgba = (hex, a) => { const n = parseInt(String(hex).slice(1), 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const fSol = (n) => { const a = Math.abs(n || 0), d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4; return (n > 0 ? '+' : n < 0 ? '-' : '') + a.toFixed(d); };
const fAbs = (n) => { const a = Math.abs(n || 0); return a.toFixed(a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4); };
const fUsd = (n) => { const a = Math.abs(n), s = n > 0 ? '+' : n < 0 ? '-' : ''; return s + '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : 2 })); };
const fPct = (p) => (p > 0 ? '+' : p < 0 ? '-' : '') + Math.abs(p).toLocaleString('en-US', { maximumFractionDigits: Math.abs(p) >= 100 ? 0 : 1 }) + '%';

function loadImg(src, cors) {
  return new Promise((res) => {
    if (!src) return res(null);
    const i = new Image(); let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    if (cors) i.crossOrigin = 'anonymous';
    i.referrerPolicy = 'no-referrer'; i.decoding = 'async';
    i.onload = () => fin(i); i.onerror = () => fin(null); setTimeout(() => fin(null), 7000);
    i.src = src;
  });
}
// true when drawing this image leaves a canvas exportable
function clean(img) { try { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 1, 1); x.getImageData(0, 0, 1, 1); return true; } catch { return false; } }
async function tokenImage(src) {
  for (const u of [safeUrl(src), imgFallback(src)].filter(Boolean)) { const i = await loadImg(u, true); if (i && clean(i)) return i; }
  return null;
}
async function fontsReady() {
  if (!document.fonts?.load) return;
  const want = [`700 120px ${SANS}`, `600 30px ${SANS}`, `600 30px ${MONO}`, `400 20px ${MONO}`].map((f) => document.fonts.load(f).catch(() => {}));
  await Promise.race([Promise.all(want), new Promise((r) => setTimeout(r, 1500))]);
}

function rr(x, X, Y, w, h, r) { x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + w, Y, X + w, Y + h, r); x.arcTo(X + w, Y + h, X, Y + h, r); x.arcTo(X, Y + h, X, Y, r); x.arcTo(X, Y, X + w, Y, r); x.closePath(); }
function cover(x, img, X, Y, w, h) {
  const s = Math.max(w / img.width, h / img.height), sw = w / s, sh = h / s;
  x.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, X, Y, w, h);
}
// the Nought mark: a ring with a slash through it
function mark(x, cx, cy, r, fg) {
  x.save(); x.lineCap = 'round';
  x.strokeStyle = fg; x.lineWidth = r * 0.38; x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = BRAND; x.lineWidth = r * 0.3; x.beginPath(); x.moveTo(cx - r * 0.72, cy + r * 0.72); x.lineTo(cx + r * 0.72, cy - r * 0.72); x.stroke();
  x.restore();
}
function fit(x, text, weight, size, maxW, fam) { let s = size; x.font = `${weight} ${s}px ${fam}`; while (s > 40 && x.measureText(text).width > maxW) { s -= 6; x.font = `${weight} ${s}px ${fam}`; } return s; }

function draw(cv, d, st, tok) {
  const x = cv.getContext('2d'), accent = d.pnlSol >= 0 ? st.up : st.down;
  x.save(); x.clearRect(0, 0, W, H); x.textBaseline = 'alphabetic'; x.textAlign = 'left';
  x.fillStyle = st.bg; x.fillRect(0, 0, W, H);
  if (bg?.img) {
    cover(x, bg.img, 0, 0, W, H);
    const g = x.createLinearGradient(0, 0, W, 0); g.addColorStop(0, rgba(st.bg, 0.9)); g.addColorStop(0.6, rgba(st.bg, 0.6)); g.addColorStop(1, rgba(st.bg, 0.2));
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  } else {
    const g = x.createRadialGradient(W * 0.84, H * 0.42, 20, W * 0.84, H * 0.42, 620); g.addColorStop(0, rgba(accent, 0.24)); g.addColorStop(1, rgba(accent, 0));
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.strokeStyle = rgba(st.fg, 0.04); x.lineWidth = 1; x.beginPath();
    for (let i = 40; i < W; i += 40) { x.moveTo(i + 0.5, 0); x.lineTo(i + 0.5, H); }
    for (let j = 40; j < H; j += 40) { x.moveTo(0, j + 0.5); x.lineTo(W, j + 0.5); }
    x.stroke();
    x.save(); x.globalAlpha = 0.07; mark(x, W - 190, H / 2 + 30, 170, st.fg); x.restore();
  }
  rr(x, 1.5, 1.5, W - 3, H - 3, 20); x.strokeStyle = rgba(st.fg, 0.12); x.lineWidth = 3; x.stroke();

  // brand + 0% fees
  mark(x, 82, 76, 19, st.fg);
  x.fillStyle = st.fg; x.font = `600 34px ${SANS}`; x.textBaseline = 'middle'; x.fillText('nought', 118, 77);
  x.font = `600 24px ${MONO}`; const chip = '0% fees', cw = x.measureText(chip).width + 40;
  rr(x, W - 64 - cw, 52, cw, 48, 24); x.fillStyle = rgba(st.up, 0.14); x.fill(); x.strokeStyle = rgba(st.up, 0.6); x.lineWidth = 2; x.stroke();
  x.fillStyle = st.up; x.fillText(chip, W - 64 - cw + 20, 77);

  // token
  const ty = 146, ts = 88;
  x.save(); rr(x, 64, ty, ts, ts, 18); x.clip();
  if (tok) cover(x, tok, 64, ty, ts, ts);
  else {
    x.fillStyle = rgba(accent, 0.18); x.fillRect(64, ty, ts, ts);
    x.fillStyle = accent; x.font = `700 34px ${MONO}`; x.textAlign = 'center'; x.fillText((d.symbol || d.mint || '?').slice(0, 2).toUpperCase(), 64 + ts / 2, ty + ts / 2 + 2); x.textAlign = 'left';
  }
  x.restore();
  rr(x, 64, ty, ts, ts, 18); x.strokeStyle = rgba(st.fg, 0.16); x.lineWidth = 2; x.stroke();
  x.textBaseline = 'alphabetic'; x.fillStyle = st.fg;
  fit(x, '$' + (d.symbol || short(d.mint)), 700, 50, W - 420, SANS); x.fillText('$' + (d.symbol || short(d.mint)), 176, ty + 48);
  x.font = `400 22px ${MONO}`; x.fillStyle = rgba(st.fg, 0.5); x.fillText(short(d.mint, 6), 178, ty + 82);

  // the result
  const big = d.pnlPct == null ? `${fSol(d.pnlSol)} SOL` : fPct(d.pnlPct);
  fit(x, big, 700, 176, W - 140, SANS); x.fillStyle = accent; x.fillText(big, 58, 448);
  x.font = `600 40px ${MONO}`; const solTxt = `${fSol(d.pnlSol)} SOL`; x.fillText(solTxt, 64, 512);
  if (st.usd && d.pnlUsd != null && isFinite(d.pnlUsd)) { const w = x.measureText(solTxt).width; x.fillStyle = rgba(st.fg, 0.6); x.font = `500 34px ${MONO}`; x.fillText(`${fUsd(d.pnlUsd)}`, 64 + w + 22, 512); }

  // stats + footer
  const stat = (k, v, X) => { x.font = `500 21px ${SANS}`; x.fillStyle = rgba(st.fg, 0.5); x.fillText(k, X, 584); x.font = `600 32px ${MONO}`; x.fillStyle = st.fg; x.fillText(v, X, 624); };
  stat('Invested', `${fAbs(d.investedSol)} SOL`, 64);
  stat('Sold for', `${fAbs(d.soldSol)} SOL`, 360);
  x.textAlign = 'right'; x.font = `500 21px ${SANS}`; x.fillStyle = rgba(st.fg, 0.5);
  x.fillText('Traded with zero platform fees', W - 64, 584);
  x.font = `500 24px ${MONO}`; x.fillStyle = rgba(st.fg, 0.75);
  x.fillText(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), W - 64, 624);
  x.restore();
}

function blobOf(cv) {
  return new Promise((res, rej) => { try { cv.toBlob((b) => (b ? res(b) : rej(new Error('The image could not be made.'))), 'image/png'); } catch (e) { rej(e); } });
}
function save(blob, name) {
  const a = document.createElement('a'), u = URL.createObjectURL(blob);
  a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 4000);
}

export async function openPnlCard(input = {}) {
  const num = (v) => (isFinite(Number(v)) ? Number(v) : 0);
  const d = {
    mint: String(input.mint || ''), symbol: String(input.symbol || '').replace(/^\$/, '').replace(/[\u0000-\u001f]/g, '').slice(0, 24), image: input.image || '',
    investedSol: num(input.investedSol), soldSol: num(input.soldSol), pnlSol: num(input.pnlSol),
    pnlPct: input.pnlPct == null || !isFinite(Number(input.pnlPct)) ? null : Number(input.pnlPct),
    pnlUsd: input.pnlUsd == null || !isFinite(Number(input.pnlUsd)) ? null : Number(input.pnlUsd),
  };
  let st = loadStyle(), tok = null;
  const dlg = document.createElement('dialog'); dlg.className = 'pnlcard-dlg'; dlg.setAttribute('aria-label', 'PnL card');
  dlg.innerHTML = `<form method="dialog" class="pc">
    <div class="pc-h"><h2>PnL card</h2><span class="pc-sub mono">${esc(d.symbol ? '$' + d.symbol : short(d.mint))} · 1200×675</span><button class="pc-x" value="cancel" aria-label="Close">${ICON.close}</button></div>
    <div class="pc-stage"><canvas width="${W}" height="${H}" aria-label="PnL card preview"></canvas></div>
    <div class="pc-ctl">
      <label class="btn btn-ghost pc-up">Background image<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
      <button type="button" class="btn btn-ghost" data-pc="nobg">No image</button>
      <label class="pc-col">Background<input type="color" data-k="bg"></label>
      <label class="pc-col">Profit<input type="color" data-k="up"></label>
      <label class="pc-col">Loss<input type="color" data-k="down"></label>
      <label class="pc-col">Text<input type="color" data-k="fg"></label>
      <label class="pc-chk"><input type="checkbox" data-k="usd"> USD</label>
      <button type="button" class="btn btn-ghost" data-pc="reset">Reset</button>
    </div>
    <div class="pc-foot"><span class="pc-note">Drawn in your browser. Nothing is uploaded.</span><button type="button" class="btn" data-pc="copy">Copy image</button><button type="button" class="btn btn-accent" data-pc="png">Download PNG</button></div>
  </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  const cv = dlg.querySelector('canvas'), file = dlg.querySelector('input[type=file]');
  const syncInputs = () => { for (const i of dlg.querySelectorAll('[data-k]')) { if (i.type === 'checkbox') i.checked = !!st[i.dataset.k]; else i.value = st[i.dataset.k]; } };
  const redraw = () => draw(cv, d, st, tok);
  const name = `nought-pnl-${(d.symbol || d.mint.slice(0, 6) || 'coin').replace(/[^a-z0-9]+/gi, '').slice(0, 20) || 'coin'}.png`;
  // export, falling back to initials if the token picture somehow tainted the canvas
  async function blob() {
    try { return await blobOf(cv); } catch (e) { if (!tok) throw e; tok = null; redraw(); return blobOf(cv); }
  }
  async function download() { try { save(await blob(), name); } catch (e) { toast(esc(e.message || 'Could not make the image.'), 'err'); } }
  async function copyImage() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') { await download(); toast('This browser cannot copy images, so the PNG was downloaded instead.'); return; }
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob() })]); toast('Card copied. Paste it anywhere.', 'ok'); return; } catch { /* try a plain blob */ }
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': await blob() })]); toast('Card copied. Paste it anywhere.', 'ok'); }
    catch { await download(); toast('Copying images is blocked here, so the PNG was downloaded instead.'); }
  }

  syncInputs(); redraw();
  dlg.addEventListener('input', (e) => {
    const k = e.target.dataset?.k; if (!k) return;
    if (k === 'usd') st.usd = e.target.checked; else if (HEX.test(e.target.value)) st[k] = e.target.value;
    LS.set('pnlcard.style', st); redraw();
  });
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pc]'); if (!b) return;
    const a = b.dataset.pc;
    if (a === 'png') download();
    else if (a === 'copy') copyImage();
    else if (a === 'nobg') { if (bg) URL.revokeObjectURL(bg.url); bg = null; redraw(); }
    else if (a === 'reset') { st = { ...DEF }; LS.set('pnlcard.style', st); syncInputs(); redraw(); }
  });
  file.addEventListener('change', async () => {
    const f = file.files?.[0]; file.value = '';
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(f.type)) { toast('Pick a PNG, JPEG, WebP or GIF image.', 'err'); return; }
    if (f.size > 15e6) { toast('That image is over 15 MB.', 'err'); return; }
    const url = URL.createObjectURL(f), im = await loadImg(url, false);
    if (!im) { URL.revokeObjectURL(url); toast('Could not read that image.', 'err'); return; }
    if (bg) URL.revokeObjectURL(bg.url);
    bg = { img: im, url }; redraw();
  });
  await fontsReady(); if (!dlg.isConnected) return; redraw();
  tok = await tokenImage(d.image); if (dlg.isConnected) redraw();
}
