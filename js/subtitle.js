// 字幕の描画（プレビュー用DOMと書き出し用ラスタライズで共通のスタイル定義を使う）
import { clamp, hexToRgba } from './util.js';

// サイズ系の値はすべて「動画の短辺 1080px 換算」の px。実寸 = 値 × (短辺 / 1080)
export const DEFAULT_STYLE = {
  fontFamily: '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "YuGothic", "Noto Sans JP", "Meiryo", sans-serif',
  customFontId: null,
  fontSize: 64,
  fontWeight: 700,
  italic: false,
  color: '#ffffff',
  strokeWidth: 0,       // 縁取り（既定はなし）
  strokeColor: '#000000',
  shadowEnabled: true,
  shadowColor: '#000000',
  shadowOpacity: 0.6,
  shadowBlur: 8,
  shadowX: 2,
  shadowY: 3,
  bgMode: 'none',      // none | box | band
  bgColor: '#000000',
  bgOpacity: 0.45,
  bgPadding: 16,
  bgRadius: 10,
  writingMode: 'horizontal', // horizontal | vertical
  posX: 50,            // 中心位置（%）
  posY: 50,
  letterSpacing: 0.04, // em
  lineHeight: 1.45,
  maxSize: 90,         // 1行の最大長（動画幅/高さに対する%）。超えると折り返す
  latinUpright: false, // 縦書き時に英字も正立させる
  tcy: true,           // 縦書き時の縦中横（2桁までの半角数字）
  animation: 'fade',   // none | fade | slideUp | zoom | wipe
  animIn: 0.25,
  animOut: 0.15,
};

export const FONT_PRESETS = [
  { label: 'ヒラギノ角ゴ（ゴシック）', value: '"Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", "YuGothic", "Noto Sans JP", "Meiryo", sans-serif' },
  { label: 'ヒラギノ明朝（明朝）', value: '"Hiragino Mincho ProN", "Hiragino Mincho Pro", "Yu Mincho", "YuMincho", "Noto Serif JP", serif' },
  { label: 'ヒラギノ丸ゴ', value: '"Hiragino Maru Gothic ProN", "Hiragino Maru Gothic Pro", "Kosugi Maru", sans-serif' },
  { label: '游ゴシック', value: '"Yu Gothic", "YuGothic", "Hiragino Sans", sans-serif' },
  { label: '游明朝', value: '"Yu Mincho", "YuMincho", "Hiragino Mincho ProN", serif' },
  { label: 'Noto Sans JP', value: '"Noto Sans JP", "Hiragino Sans", sans-serif' },
  { label: 'Noto Serif JP', value: '"Noto Serif JP", "Hiragino Mincho ProN", serif' },
  { label: 'クレー（手書き風）', value: '"Klee One", "Klee", "Hiragino Maru Gothic ProN", sans-serif' },
  { label: 'ゴシック（汎用）', value: 'sans-serif' },
  { label: '明朝（汎用）', value: 'serif' },
];

export const STYLE_PRESETS = {
  '白文字＋黒縁': { color: '#ffffff', strokeWidth: 4, strokeColor: '#000000', shadowEnabled: true, bgMode: 'none' },
  '黒帯': { color: '#ffffff', strokeWidth: 0, shadowEnabled: false, bgMode: 'band', bgColor: '#000000', bgOpacity: 0.55 },
  'ボックス': { color: '#ffffff', strokeWidth: 0, shadowEnabled: false, bgMode: 'box', bgColor: '#000000', bgOpacity: 0.5, bgRadius: 12 },
  '明朝・縦書き': { writingMode: 'vertical', fontFamily: FONT_PRESETS[1].value, fontWeight: 600, strokeWidth: 0, shadowEnabled: true, shadowBlur: 12, shadowOpacity: 0.8, bgMode: 'none', posX: 80 },
  'ネオン': { color: '#fff6c4', strokeWidth: 2, strokeColor: '#ff3d9a', shadowEnabled: true, shadowColor: '#ff3d9a', shadowBlur: 24, shadowOpacity: 0.9, shadowX: 0, shadowY: 0, bgMode: 'none' },
};

/** 縦中横：2桁までの半角数字（前後が数字でないもの）を span で包む */
function tcyHtml(text) {
  return text.replace(/(?<![0-9])([0-9]{1,2})(?![0-9])/g, '<span style="text-combine-upright:all">$1</span>');
}
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * 字幕要素を生成する。frameW/frameH は「この要素を描く座標系での動画サイズ(px)」。
 * プレビューでは表示サイズ、書き出しでは動画の実解像度を渡す。
 */
export function createCueElement(doc, text, style, frameW, frameH, fontFamilyOverride) {
  const k = Math.min(frameW, frameH) / 1080;
  const vertical = style.writingMode === 'vertical';
  const el = doc.createElement('div');
  el.setAttribute('lang', 'ja');
  const s = el.style;
  s.boxSizing = 'border-box';
  s.display = 'block';
  s.whiteSpace = 'pre-wrap';
  s.lineBreak = 'strict';
  s.wordBreak = 'normal';
  s.overflowWrap = 'anywhere';
  s.textAlign = 'center';
  s.fontFamily = fontFamilyOverride || style.fontFamily;
  s.fontSize = `${style.fontSize * k}px`;
  s.fontWeight = String(style.fontWeight);
  s.fontStyle = style.italic ? 'italic' : 'normal';
  s.lineHeight = String(style.lineHeight);
  s.letterSpacing = `${style.letterSpacing}em`;
  s.color = style.color;
  s.fontKerning = 'normal';
  s.fontFeatureSettings = vertical ? '"vert" 1, "vkrn" 1' : '"palt" 0';
  s.writingMode = vertical ? 'vertical-rl' : 'horizontal-tb';
  s.textOrientation = vertical ? (style.latinUpright ? 'upright' : 'mixed') : 'mixed';
  if (style.strokeWidth > 0) {
    // paint-order で縁取りを文字の外側にだけ見せる（幅は2倍して半分を文字の下に隠す）
    s.webkitTextStroke = `${style.strokeWidth * 2 * k}px ${style.strokeColor}`;
    s.paintOrder = 'stroke fill';
    s.webkitTextStrokeColor = style.strokeColor;
  }
  if (style.shadowEnabled) {
    s.textShadow = `${style.shadowX * k}px ${style.shadowY * k}px ${style.shadowBlur * k}px ${hexToRgba(style.shadowColor, style.shadowOpacity)}`;
  }
  const pad = style.bgMode === 'none' ? 0 : style.bgPadding * k;
  if (style.bgMode !== 'none') {
    s.background = hexToRgba(style.bgColor, style.bgOpacity);
    s.borderRadius = style.bgMode === 'box' ? `${style.bgRadius * k}px` : '0';
    s.padding = vertical ? `${pad}px ${pad * 1.1}px` : `${pad * 0.6}px ${pad}px`;
  }
  const maxInline = (vertical ? frameH : frameW) * (style.maxSize / 100);
  if (style.bgMode === 'band') {
    if (vertical) { s.height = `${frameH}px`; } else { s.width = `${frameW}px`; }
    s.display = 'flex';
    s.alignItems = 'center';
    s.justifyContent = 'center';
  } else if (vertical) {
    s.maxHeight = `${maxInline}px`;
    s.width = 'max-content';
  } else {
    s.maxWidth = `${maxInline}px`;
    s.width = 'max-content';
  }
  const inner = (vertical && style.tcy && !style.latinUpright) ? tcyHtml(esc(text)) : esc(text);
  if (style.bgMode === 'band') {
    const span = doc.createElement('div');
    span.style.maxWidth = vertical ? '' : `${maxInline}px`;
    span.style.maxHeight = vertical ? `${maxInline}px` : '';
    span.innerHTML = inner;
    el.appendChild(span);
  } else {
    el.innerHTML = inner;
  }
  return el;
}

/** 要素サイズ(bw,bh)から左上座標を決める（動画内に収まるようクランプ） */
export function layoutBox(bw, bh, frameW, frameH, style) {
  const band = style.bgMode === 'band';
  const vertical = style.writingMode === 'vertical';
  const m = Math.min(frameW, frameH) * 0.02;
  const cx = (band && !vertical) ? frameW / 2 : frameW * style.posX / 100;
  const cy = (band && vertical) ? frameH / 2 : frameH * style.posY / 100;
  const fit = (c, size, total) => size + 2 * m >= total ? (total - size) / 2 : clamp(c - size / 2, m, total - size - m);
  return { x: (band && !vertical) ? 0 : fit(cx, bw, frameW), y: (band && vertical) ? 0 : fit(cy, bh, frameH) };
}

const easeOut = p => 1 - Math.pow(1 - p, 3);

/**
 * 表示アニメーションの状態（プレビューと書き出しで共通）。
 * reveal: ワイプの表示割合(0..1), dy: 縦移動量(短辺1080換算px)
 */
export function animState(t, start, end, style) {
  const a = style.animation;
  const st = { opacity: 1, scale: 1, dy: 0, reveal: 1 };
  if (a === 'none') return st;
  const len = Math.max(0.001, end - start);
  const inD = Math.min(style.animIn, len / 2), outD = Math.min(style.animOut, len / 2);
  const pIn = inD > 0 ? clamp((t - start) / inD, 0, 1) : 1;
  const pOut = outD > 0 && isFinite(end) ? clamp((end - t) / outD, 0, 1) : 1;
  const eIn = easeOut(pIn), eOut = easeOut(pOut);
  st.opacity = Math.min(eIn, eOut);
  if (a === 'slideUp') st.dy = (1 - eIn) * 28 - (1 - eOut) * 14;
  if (a === 'zoom') st.scale = 0.86 + 0.14 * eIn;
  if (a === 'wipe') { st.reveal = eIn; st.opacity = eOut; }
  return st;
}

/** ワイプ用 clip-path（プレビュー）。影や縁取りがはみ出す分 p(px) は切らない */
export function wipeClip(reveal, vertical, bw, bh, p) {
  if (reveal >= 1) return '';
  return vertical
    ? `inset(-${p}px -${p}px ${(1 - reveal) * bh}px -${p}px)`
    : `inset(-${p}px ${(1 - reveal) * bw}px -${p}px -${p}px)`;
}

/**
 * 書き出し用：字幕1行を動画の実解像度でラスタライズして ImageBitmap を返す。
 * SVG foreignObject を使うため、プレビューと同じ CSS 組版（縦書き・約物・縦中横）がそのまま使われる。
 * @returns {{bitmap, x, y, w, h, pad}}  x,y は bitmap を描く左上座標（pad 込み）
 */
export async function rasterizeCue(text, style, frameW, frameH, fontCss = '', fontFamilyOverride) {
  const el = createCueElement(document, text, style, frameW, frameH, fontFamilyOverride);
  // 実寸レイアウトを測るための不可視ホスト
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-100000px;top:0;width:${frameW}px;height:${frameH}px;visibility:hidden;contain:layout;`;
  host.appendChild(el);
  document.body.appendChild(host);
  if (document.fonts?.ready) await document.fonts.ready;
  const rect = el.getBoundingClientRect();
  host.remove();
  const bw = Math.ceil(rect.width), bh = Math.ceil(rect.height);
  const k = Math.min(frameW, frameH) / 1080;
  const pad = Math.ceil((style.strokeWidth * 2 + (style.shadowEnabled ? style.shadowBlur * 2 + Math.abs(style.shadowX) + Math.abs(style.shadowY) : 0) + 8) * k);
  const W = bw + pad * 2, H = bh + pad * 2;
  el.style.position = 'absolute';
  el.style.left = `${pad}px`;
  el.style.top = `${pad}px`;
  el.style.width = `${bw}px`;
  el.style.height = `${bh}px`;
  const xhtml = new XMLSerializer().serializeToString(el);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}"><div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${W}px;height:${H}px;margin:0;"><style>${fontCss}</style>${xhtml}</div></foreignObject></svg>`;
  const img = new Image();
  img.decoding = 'sync';
  // blob: URL の foreignObject SVG は Chrome で canvas が汚染(tainted)扱いになるため data: URL を使う
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  // フォント読み込みを待つため一度 canvas に描いてから bitmap 化
  const c = new OffscreenCanvas(W, H);
  c.getContext('2d').drawImage(img, 0, 0, W, H);
  const bitmap = await createImageBitmap(c);
  const pos = layoutBox(bw, bh, frameW, frameH, style);
  return { bitmap, x: pos.x - pad, y: pos.y - pad, w: W, h: H, pad, bw, bh };
}

/** 書き出しフレームへの字幕描画（animState を適用） */
export function drawCueRaster(ctx, r, st, style, frameW, frameH) {
  if (st.opacity <= 0.001 || st.reveal <= 0.001) return;
  const k = Math.min(frameW, frameH) / 1080;
  const vertical = style.writingMode === 'vertical';
  ctx.save();
  ctx.globalAlpha = st.opacity;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2 + st.dy * k;
  ctx.translate(cx, cy);
  if (st.scale !== 1) ctx.scale(st.scale, st.scale);
  ctx.translate(-r.w / 2, -r.h / 2);
  if (st.reveal < 1) {
    ctx.beginPath();
    // 要素本体（pad の内側）を基準にワイプ。はみ出す影/縁取りの分も含める
    if (vertical) ctx.rect(0, 0, r.w, r.pad + r.bh * st.reveal);
    else ctx.rect(0, 0, r.pad + r.bw * st.reveal, r.h);
    ctx.clip();
  }
  ctx.drawImage(r.bitmap, 0, 0);
  ctx.restore();
}
