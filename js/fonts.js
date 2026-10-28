// Mac のフォント（Pages などで選べるもの）
// 日本語フォントは macOS のフォントカタログ（Font Book / Pages で選択すると自動ダウンロードされるもの）に合わせている。
// 未ダウンロードのフォントは、Font Book.app で「ダウンロード」するか Pages で一度使うと利用できるようになる。

const GOTHIC = '"Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif';
const MINCHO = '"Hiragino Mincho ProN", serif';
const MARU = '"Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif';

export const MAC_FONT_GROUPS = [
  { label: '日本語・ゴシック', fallback: GOTHIC, fonts: [
    ['Hiragino Sans', 'ヒラギノ角ゴシック'],
    ['Hiragino Kaku Gothic ProN', 'ヒラギノ角ゴ ProN'],
    ['Hiragino Kaku Gothic StdN', 'ヒラギノ角ゴ StdN'],
    ['YuGothic', '游ゴシック体'],
    ['Toppan Bunkyu Gothic', '凸版文久ゴシック'],
    ['Toppan Bunkyu Midashi Gothic', '凸版文久見出しゴシック'],
    ['BIZ UDGothic', 'BIZ UDゴシック'],
    ['Osaka', 'Osaka'],
  ] },
  { label: '日本語・丸ゴシック', fallback: MARU, fonts: [
    ['Hiragino Maru Gothic ProN', 'ヒラギノ丸ゴ ProN'],
    ['Tsukushi A Round Gothic', '筑紫A丸ゴシック'],
    ['Tsukushi B Round Gothic', '筑紫B丸ゴシック'],
  ] },
  { label: '日本語・明朝', fallback: MINCHO, fonts: [
    ['Hiragino Mincho ProN', 'ヒラギノ明朝 ProN'],
    ['YuMincho', '游明朝体'],
    ['YuMincho +36p Kana', '游明朝体+36ポかな'],
    ['Toppan Bunkyu Mincho', '凸版文久明朝'],
    ['Toppan Bunkyu Midashi Mincho', '凸版文久見出し明朝'],
    ['BIZ UDMincho', 'BIZ UD明朝'],
  ] },
  { label: '日本語・手書き / 教科書体', fallback: GOTHIC, fonts: [
    ['Klee', 'クレー'],
    ['YuKyokasho', '游教科書体'],
    ['YuKyokasho Yoko', '游教科書体 横'],
  ] },
  { label: '欧文（日本語はヒラギノで表示）', fallback: GOTHIC, fonts: [
    ['Helvetica Neue', 'Helvetica Neue'], ['Avenir Next', 'Avenir Next'], ['Futura', 'Futura'], ['Gill Sans', 'Gill Sans'],
    ['Optima', 'Optima'], ['Georgia', 'Georgia'], ['Baskerville', 'Baskerville'], ['Didot', 'Didot'],
    ['Times New Roman', 'Times New Roman'], ['Palatino', 'Palatino'], ['American Typewriter', 'American Typewriter'],
    ['Copperplate', 'Copperplate'], ['Rockwell', 'Rockwell'], ['Impact', 'Impact'], ['Marker Felt', 'Marker Felt'],
    ['Chalkboard SE', 'Chalkboard SE'], ['Noteworthy', 'Noteworthy'], ['Bradley Hand', 'Bradley Hand'],
    ['Snell Roundhand', 'Snell Roundhand'], ['Zapfino', 'Zapfino'], ['Courier New', 'Courier New'],
  ] },
];

/** フォントファミリー名 → CSS の font-family 値（日本語が無いフォントでもヒラギノで補う） */
export function fontCss(family, fallback = GOTHIC) {
  return `"${family.replace(/"/g, '')}", ${fallback}`;
}

/** font-family 値の先頭ファミリー名 */
export const primaryFamily = css => (css || '').split(',')[0].replace(/["']/g, '').trim();

// インストール済み判定：既定フォントと文字幅が変わるかで判定する
const probeCtx = document.createElement('canvas').getContext('2d');
const SAMPLE = 'あいう漢字カナABCabcWwMm0123';
const cache = new Map();
export function isFontAvailable(family) {
  if (cache.has(family)) return cache.get(family);
  let ok = false;
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    probeCtx.font = `72px ${base}`;
    const w0 = probeCtx.measureText(SAMPLE).width;
    probeCtx.font = `72px "${family}", ${base}`;
    if (Math.abs(probeCtx.measureText(SAMPLE).width - w0) > 0.5) { ok = true; break; }
  }
  cache.set(family, ok);
  return ok;
}

const LS_KEY = 'lse.localFontFamilies';

/** 以前に読み込んだ「Mac のすべてのフォント」の一覧 */
export function savedLocalFamilies() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}

/** Local Font Access API で Mac にインストールされている全フォントを取得（Chrome / Edge。許可が必要） */
export async function loadAllLocalFamilies() {
  if (!window.queryLocalFonts) throw new Error('このブラウザはフォント一覧の取得に対応していません（Chrome を使ってください）');
  const fonts = await window.queryLocalFonts();
  const fams = [...new Set(fonts.map(f => f.family))].filter(f => !f.startsWith('.')).sort((a, b) => a.localeCompare(b, 'ja'));
  try { localStorage.setItem(LS_KEY, JSON.stringify(fams)); } catch { /* 保存できなくても一覧は使える */ }
  return fams;
}
