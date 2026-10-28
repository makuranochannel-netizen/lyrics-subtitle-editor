// 汎用ユーティリティ

export const uid = (p = '') =>
  p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 秒 → "m:ss.mmm" */
export function fmtTime(sec, withMs = true) {
  if (sec == null || !isFinite(sec)) return '--:--' + (withMs ? '.---' : '');
  const neg = sec < 0;
  sec = Math.abs(sec);
  let m = Math.floor(sec / 60);
  let s = sec - m * 60;
  if (withMs) {
    let ms = Math.round(s * 1000);
    if (ms >= 60000) { m += 1; ms -= 60000; }
    const ss = Math.floor(ms / 1000), mmm = ms % 1000;
    return `${neg ? '-' : ''}${m}:${String(ss).padStart(2, '0')}.${String(mmm).padStart(3, '0')}`;
  }
  return `${neg ? '-' : ''}${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

/** "m:ss.mmm" / "ss.mmm" / "h:mm:ss.mmm" → 秒。失敗時 null */
export function parseTime(str) {
  if (str == null) return null;
  str = String(str).trim().replace('：', ':').replace('．', '.');
  if (!str) return null;
  const parts = str.split(':');
  if (parts.length > 3 || parts.some(p => p === '' || isNaN(Number(p)))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return sec >= 0 ? sec : null;
}

/** SRT 形式 "hh:mm:ss,mmm" */
export function fmtSrt(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtBytes(n) {
  if (!n && n !== 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function hexToRgba(hex, a = 1) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

export const deepClone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));

/**
 * 歌詞テキストの再編集時に、行IDをできるだけ維持して新しい行配列を作る。
 * 1) 本文が一致する行を順序を保って対応付け（LCS）
 * 2) 対応付いた行の間に挟まれた未対応の行同士を、順に対応付け（文字修正とみなしIDを引き継ぐ）
 * 3) 順序が入れ替わっただけの同じ本文の行も対応付け
 * 4) 残りは新しい行として新規ID
 */
export function mergeLines(oldLines, newTexts) {
  const n = oldLines.length, m = newTexts.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = oldLines[i].text === newTexts[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ids = new Array(m).fill(null);
  const anchors = [[-1, -1]];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (oldLines[i].text === newTexts[j]) { ids[j] = oldLines[i].id; anchors.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  anchors.push([n, m]);
  for (let k = 0; k + 1 < anchors.length; k++) {
    const [oi, nj] = anchors[k], [oi2, nj2] = anchors[k + 1];
    for (let a = oi + 1, b = nj + 1; a < oi2 && b < nj2; a++, b++) ids[b] = oldLines[a].id;
  }
  // 3) 順序が入れ替わった同じ本文の行
  const used = new Set(ids.filter(Boolean));
  for (let j = 0; j < m; j++) {
    if (ids[j]) continue;
    const o = oldLines.find(l => !used.has(l.id) && l.text === newTexts[j]);
    if (o) { ids[j] = o.id; used.add(o.id); }
  }
  return newTexts.map((text, j) => ({ id: ids[j] || uid('l_'), text }));
}

export const splitLyrics = text =>
  text.replace(/\r\n?/g, '\n').split('\n').map(s => s.trim()).filter(s => s.length > 0);
