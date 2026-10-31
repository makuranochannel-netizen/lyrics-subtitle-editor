// 歌詞字幕エディタ — メインコントローラー
import { db } from './db.js';
import { uid, clamp, fmtTime, parseTime, fmtSrt, debounce, escapeHtml, fmtBytes, downloadBlob, deepClone, hexToRgba, parseLyricsText, lyricsToText, mergeLyricsText, sectionsOf, uniqueNames } from './util.js';
import { buildCues, activeCueAt, firstUnrecorded, removeCuesKeepingGaps, sectionRanges } from './cues.js';
import { DEFAULT_STYLE, STYLE_PRESETS, createCueElement, layoutBox, animState, wipeClip } from './subtitle.js';
import { Timeline } from './timeline.js';
import { LIB_CHANNEL, PENDING_KEY, openLibraryPage } from './library-link.js';
import { MAC_FONT_GROUPS, fontCss, primaryFamily, isFontAvailable, savedLocalFamilies, loadAllLocalFamilies } from './fonts.js';
import { exportVideo } from './exporter.js';
import { readMovie, describeTracks } from './demux.js';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const video = $('#video');
const libChannel = 'BroadcastChannel' in window ? new BroadcastChannel(LIB_CHANNEL) : null;

const S = {
  project: null,
  library: [],
  fonts: [],
  file: null,
  videoUrl: null,
  probe: null,
  cues: [],
  undo: [],
  redo: [],
  dirty: false,
  selectedId: null,
  overlayKey: null,
  overlayEl: null,
  overlayBox: null,
  stageW: 0,
  stageH: 0,
  exporting: false,
};
window.app = S; // デバッグ用

// ============================================================
// プロジェクト
// ============================================================
function newProject(name = '新しいプロジェクト') {
  const now = Date.now();
  return {
    id: uid('p_'), name, createdAt: now, updatedAt: now,
    lyricSetId: null, lyricTitle: '',
    lines: [],            // 歌詞（行ID・本文・順序）
    timings: {},          // タイミング（行IDごと）※歌詞とは分離
    style: { ...DEFAULT_STYLE },
    video: null,          // 動画の情報（ファイル本体は別ストア／再選択）
    editor: { cursor: 0, currentTime: 0, recordKey: 'Shift', recordOffset: 0, seekStep: 2, zoom: 80, storeVideo: false, compactTimeline: false },
  };
}

function normalizeProject(p) {
  const base = newProject();
  p.style = { ...DEFAULT_STYLE, ...(p.style || {}) };
  p.editor = { ...base.editor, ...(p.editor || {}) };
  p.lines = p.lines || [];
  p.timings = p.timings || {};
  return p;
}

const P = () => S.project;

async function saveProject(manual = false) {
  const p = P();
  if (!p) return;
  p.editor.currentTime = video.currentTime || 0;
  p.updatedAt = Date.now();
  try {
    await db.put('projects', deepClone(p));
    await db.setMeta('lastProjectId', p.id);
    S.dirty = false;
    updateSaveState();
    if (manual) toast('保存しました');
  } catch (e) {
    console.error(e);
    toast('保存に失敗しました: ' + e.message, true);
  }
}
const autosave = debounce(() => saveProject(false), 800);

function updateSaveState() {
  const el = $('#saveState');
  if (S.dirty) { el.textContent = '● 未保存の変更'; el.classList.add('dirty'); }
  else { el.textContent = '✓ 保存済み ' + new Date(P().updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }); el.classList.remove('dirty'); }
}

/** 編集後に呼ぶ：字幕再計算・各表示更新・自動保存 */
function changed({ lines = true, style = false } = {}) {
  S.dirty = true;
  updateSaveState();
  recomputeCues();
  if (lines) renderLines();
  if (P().lines.every(l => l.id !== S.selectedId)) S.selectedId = null;
  updateCueActions();
  if (style) { S.overlayKey = null; }
  renderOverlay(true);
  autosave();
}

function recomputeCues() {
  const p = P();
  S.cues = buildCues(p.lines, p.timings, video.duration || p.video?.duration);
  // 記録モード中のプレビュー用：記録位置より前の行だけで字幕を組み立てる。
  // これから記録する行に古いタイミングが残っていても表示せず、「記録開始」を押しただけでは歌詞は出ない。
  S.recordCues = S.recordMode ? buildCues(p.lines.slice(0, p.editor.cursor), p.timings, video.duration || p.video?.duration) : null;
  timeline.setCues(S.cues);
  timeline.setSections(sectionRanges(sectionsOf(p.lines), S.cues).filter(x => x.start != null)
    .map(x => ({ name: x.name, start: x.start, end: isFinite(x.end) ? x.end : (video.duration || p.video?.duration || x.start) })));
  updateRecordBar();
}

// ---------------- 取り消し / やり直し ----------------
function snapshot() {
  const p = P();
  return JSON.stringify({ lines: p.lines, timings: p.timings, style: p.style, cursor: p.editor.cursor, lyricSetId: p.lyricSetId, lyricTitle: p.lyricTitle });
}
let lastUndoLabel = null, lastUndoAt = 0;
function pushUndo(label, coalesce = false) {
  const now = Date.now();
  if (coalesce && lastUndoLabel === label && now - lastUndoAt < 1200) { lastUndoAt = now; return; }
  S.undo.push({ label, state: snapshot() });
  if (S.undo.length > 300) S.undo.shift();
  S.redo = [];
  lastUndoLabel = label; lastUndoAt = now;
}
function restore(state) {
  const s = JSON.parse(state), p = P();
  p.lines = s.lines; p.timings = s.timings; p.style = s.style; p.editor.cursor = s.cursor; p.lyricSetId = s.lyricSetId; p.lyricTitle = s.lyricTitle;
  lastUndoLabel = null;
  syncStylePanel();
  renderLyricHead();
  changed({ style: true });
}
function undo() {
  const u = S.undo.pop();
  if (!u) { toast('取り消せる操作はありません'); return; }
  S.redo.push({ label: u.label, state: snapshot() });
  restore(u.state);
  toast(`取り消し: ${u.label}`);
}
function redo() {
  const r = S.redo.pop();
  if (!r) { toast('やり直せる操作はありません'); return; }
  S.undo.push({ label: r.label, state: snapshot() });
  restore(r.state);
  toast(`やり直し: ${r.label}`);
}

// ============================================================
// タイミング記録（最重要機能）
// ============================================================
function currentMediaTime(evTimeStamp) {
  let t = video.currentTime;
  // キー入力イベント発生からハンドラ実行までの遅延を、再生中なら差し引く（動画の再生時間が基準）
  if (evTimeStamp != null && !video.paused) {
    const lag = Math.max(0, Math.min(0.1, (performance.now() - evTimeStamp) / 1000));
    t -= lag * video.playbackRate;
  }
  return t;
}

function recordNow(evTimeStamp) {
  const p = P();
  if (!p.lines.length) { toast('先に歌詞を設定してください', true); return; }
  if (!S.file) { toast('先に動画を読み込んでください', true); return; }
  const idx = p.editor.cursor;
  if (idx >= p.lines.length) { toast('すべての歌詞を記録しました（Ctrl/⌘+Z で取り消し）'); return; }
  const t = Math.max(0, currentMediaTime(evTimeStamp) - (p.editor.recordOffset || 0));
  const line = p.lines[idx];
  pushUndo(`${idx + 1}行目の記録`);
  // 直前の行に手動の終了時刻があり、新しい開始より後なら自動に戻す（重なり防止）
  const prev = p.lines[idx - 1];
  if (prev && p.timings[prev.id]?.end != null && p.timings[prev.id].end > t) p.timings[prev.id].end = null;
  p.timings[line.id] = { start: +t.toFixed(3), end: null };
  p.editor.cursor = idx + 1;
  flashStage();
  changed();
  scrollLineIntoView(p.lines[p.editor.cursor]?.id || line.id);
  if (S.recordMode && p.editor.cursor >= p.lines.length) {
    setRecordMode(false);
    toast('すべての歌詞を記録しました。記録モードを終了します');
  }
}

/** 記録モード：オンの間は記録キー（Shift）を押すだけで次の歌詞が記録される */
function setRecordMode(on) {
  const p = P();
  if (on) {
    if (!p.lines.length) { toast('先に歌詞を設定してください', true); return; }
    if (!S.file) { toast('先に動画を読み込んでください', true); return; }
    if (p.editor.cursor >= p.lines.length) {
      const first = firstUnrecorded(p.lines, p.timings);
      if (first >= p.lines.length) { toast('すべて記録済みです。やり直す行を選んで「● ここから記録」を押してください', true); return; }
      p.editor.cursor = first;
      changed();
    }
    // 入力欄にフォーカスが残っていると記録キーが文字入力に取られるため外す
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    window.focus();
  }
  S.recordMode = on;
  $('#app').classList.toggle('recording', on);
  recomputeCues();
  renderOverlay(true);
  updateRecordBar();
  if (on) {
    if (video.paused) video.play();
    toast(IS_TOUCH ? '記録モード開始：下の大きなボタンをタップして記録' : `記録モード開始：${keyLabel(p.editor.recordKey)} で歌詞を記録（Esc で終了）`);
  }
}
const toggleRecordMode = () => setRecordMode(!S.recordMode);

/** 表示中の字幕をこの時刻で消す（間奏などで字幕を消したいとき） */
function endCurrentCue(evTimeStamp) {
  if (!S.file) { toast('先に動画を読み込んでください', true); return; }
  const t = Math.max(0, currentMediaTime(evTimeStamp) - (P().editor.recordOffset || 0));
  const cue = activeCueAt(S.cues, t);
  if (!cue) { toast('いまは歌詞が表示されていません'); return; }
  pushUndo(`${cue.index + 1}行目の表示終了`);
  P().timings[cue.lineId].end = +t.toFixed(3);
  changed();
  flashStage();
  toast(`${fmtTime(t)} で歌詞を消しました（次の歌詞の記録で再び表示）`);
}

function flashStage() {
  const f = $('#recordFlash');
  f.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => f.classList.remove('on')));
}

function updateRecordBar() {
  const p = P();
  const n = p.lines.length, idx = p.editor.cursor;
  const recorded = p.lines.filter(l => p.timings[l.id]?.start != null).length;
  $('#recordKeyLabel').textContent = keyLabel(p.editor.recordKey);
  const bar = $('#recordBar');
  const btn = $('#btnRecord');
  btn.textContent = S.recordMode ? '■ 記録モード終了' : '● 記録開始';
  btn.title = S.recordMode ? '記録モードを終了 (Esc / R)' : `記録モードを開始 (R)。開始後は ${keyLabel(p.editor.recordKey)} を押すだけで記録`;
  $('#recordHint').textContent = S.recordMode ? (IS_TOUCH ? 'ここをタップして記録' : `ここをタップ / ${keyLabel(p.editor.recordKey)} で記録`) : '次に記録する歌詞';
  $('#btnUndo').disabled = !S.undo.length;
  if (!n) { $('#nextLyric').textContent = '歌詞が未設定です'; bar.classList.remove('done'); }
  else if (idx >= n) { $('#nextLyric').textContent = '✓ すべて記録済み'; bar.classList.add('done'); }
  else { $('#nextLyric').textContent = `${idx + 1}. ${p.lines[idx].text}`; bar.classList.remove('done'); }
  $('#recordStatus').textContent = n ? `${recorded} / ${n} 行 記録済み` : '';
  $('#recordProgress').style.width = n ? `${recorded / n * 100}%` : '0';
}

// タッチ操作が主の端末（iPhone / iPad）
const IS_TOUCH = matchMedia('(hover: none) and (pointer: coarse)').matches;
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const keyLabel = k => ({ Shift: 'Shift', Enter: 'Enter', KeyJ: 'J', KeyF: 'F', Tab: 'Tab' }[k] || k);

// ============================================================
// キーボードショートカット
// ============================================================
const TEXT_TYPES = new Set(['text', 'number', 'search', 'email', 'url', 'password', 'tel', '']);
function inputKind(el) {
  if (!el || el === document.body) return 'none';
  if (el.isContentEditable) return 'text';
  if (el.tagName === 'TEXTAREA') return 'text';
  if (el.tagName === 'INPUT') return TEXT_TYPES.has((el.getAttribute('type') || '').toLowerCase()) ? 'text' : 'control';
  if (el.tagName === 'SELECT') return 'control';
  return 'none';
}

function matchesRecordKey(e) {
  const k = P().editor.recordKey;
  if (k === 'Shift') return e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight'; // 左右どちらも
  if (k === 'Enter') return e.key === 'Enter';
  return e.code === k;
}

window.addEventListener('keydown', e => {
  const kind = inputKind(e.target);
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.code === 'KeyS') { e.preventDefault(); saveProject(true); return; }
  if (!$('#modal').hidden) { if (e.key === 'Escape' && !S.exporting) closeModal(); return; }
  // 記録モード中は、フォーカスの位置に関係なく記録キーで記録する（歌詞の文字・時刻を直している最中は除く）
  const editingLine = !!e.target.closest?.('.text-edit, .line-edit');
  if (S.recordMode && !editingLine && !mod && !e.altKey && matchesRecordKey(e)) {
    if (e.repeat) return;
    e.preventDefault();
    recordNow(e.timeStamp);
    return;
  }
  if (S.recordMode && e.key === 'Escape') { e.preventDefault(); setRecordMode(false); return; }
  if (S.recordMode && !editingLine && kind !== 'text' && e.code === 'KeyE' && !mod && !e.altKey) { if (!e.repeat) { e.preventDefault(); endCurrentCue(e.timeStamp); } return; }
  if (kind === 'text') return; // 文字入力中は誤作動させない
  if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  if (e.code === 'KeyR' && kind !== 'control') { e.preventDefault(); toggleRecordMode(); return; }
  if (matchesRecordKey(e) && !e.repeat && P().lines.length && S.file && P().editor.recordKey === 'Shift') {
    toast('「● 記録開始」（R キー）で記録モードにすると、Shift で歌詞を記録できます');
  }
  const isSeekBar = e.target.id === 'seek';
  if (kind === 'control' && !isSeekBar) return; // スライダーやセレクトの操作を優先
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-P().editor.seekStep); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(P().editor.seekStep); return; }
  if (e.code === 'KeyE') { e.preventDefault(); endCurrentCue(e.timeStamp); return; }
  if (e.key === ',') { e.preventDefault(); video.pause(); seekBy(-1 / 30); return; }
  if (e.key === '.') { e.preventDefault(); video.pause(); seekBy(1 / 30); return; }
}, true);

// ボタンをクリックした後にフォーカスが残り、Space で二重に反応するのを防ぐ
document.addEventListener('click', e => { const b = e.target.closest('button'); if (b) b.blur(); });
// スライダー・セレクト・チェックボックス操作後はフォーカスを外してショートカットを効かせる
document.addEventListener('change', e => { if (inputKind(e.target) === 'control' && e.target.id !== 'seek') e.target.blur(); });

// ============================================================
// 動画
// ============================================================
function togglePlay() {
  if (!S.file) { toast('動画を読み込んでください'); return; }
  if (video.paused || video.ended) video.play(); else video.pause();
}
function seekTo(t) {
  if (!S.file || !isFinite(video.duration)) return;
  video.currentTime = clamp(t, 0, video.duration);
  renderOverlay(true);
}
const seekBy = d => seekTo(video.currentTime + d);

async function openVideoDialog() {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: '動画 (MP4 / MOV)', accept: { 'video/mp4': ['.mp4', '.m4v'], 'video/quicktime': ['.mov'] } }], excludeAcceptAllOption: false });
      await loadVideoFile(await h.getFile(), h);
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn(e);
    }
  }
  $('#fileVideo').click();
}

async function loadVideoFile(file, handle = null, { fromRestore = false } = {}) {
  const p = P();
  if (!/\.(mp4|mov|m4v)$/i.test(file.name) && !/^video\//.test(file.type)) toast('MP4 / MOV 以外の形式は正しく扱えない場合があります', true);
  if (!fromRestore && p.video && (p.video.name !== file.name || p.video.size !== file.size) && Object.keys(p.timings).length) {
    toast(`前回と異なる動画です（前回: ${p.video.name}）。タイミングはそのまま使います`);
  }
  if (S.videoUrl) URL.revokeObjectURL(S.videoUrl);
  S.file = file;
  S.videoUrl = URL.createObjectURL(file);
  video.src = S.videoUrl;
  try {
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('このブラウザでは再生できない動画です（コーデック非対応の可能性）'));
    });
  } catch (e) {
    toast(e.message, true);
    S.file = null;
    return;
  }
  $('#stage').hidden = false;
  $('#dropHint').hidden = true;
  $('#reloadBanner').hidden = true;
  p.video = { name: file.name, size: file.size, lastModified: file.lastModified, type: file.type, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
  if (handle) db.put('handles', { id: p.id, handle }).catch(() => {});
  if (p.editor.storeVideo) storeVideoBlob();
  fitStage();
  timeline.setDuration(video.duration);
  updateSeekBar();
  $('#timeDur').textContent = fmtTime(video.duration);
  const t = clamp(p.editor.currentTime || 0, 0, video.duration);
  video.currentTime = t;
  changed({ lines: true });
  S.probe = null;
  renderVideoInfo();
  probeVideo(file);
  computeWaveform(file);
  if (!fromRestore) toast(`動画を読み込みました: ${file.name}`);
}

async function probeVideo(file) {
  try {
    const { mp4, info, moovBytes } = await readMovie(file);
    const T = describeTracks(mp4, info, moovBytes);
    S.probe = { vcodec: T.video?.codec, acodec: T.audio?.codec, rotation: T.video?.rotation || 0, fps: T.video?.fps };
    if (T.video) {
      try { S.probe.decodable = (await VideoDecoder.isConfigSupported({ codec: T.video.codec, codedWidth: T.video.codedWidth, codedHeight: T.video.codedHeight, description: T.video.description })).supported; } catch { S.probe.decodable = false; }
    }
  } catch (e) {
    S.probe = { error: e.message };
  }
  renderVideoInfo();
}

async function storeVideoBlob() {
  const p = P();
  if (!S.file) return;
  try {
    await db.put('videos', { id: p.id, blob: S.file, name: S.file.name, size: S.file.size, lastModified: S.file.lastModified, type: S.file.type });
    toast('動画をブラウザ内に保存しました');
  } catch (e) {
    toast('動画の保存に失敗しました（容量不足の可能性）: ' + e.message, true);
    p.editor.storeVideo = false;
    renderVideoInfo();
  }
}

/** プロジェクトを開いたときの動画復元：①ブラウザ内保存 ②ファイルハンドル ③再選択の案内 */
async function restoreVideo() {
  const p = P();
  S.file = null;
  video.removeAttribute('src'); video.load();
  $('#stage').hidden = true;
  $('#dropHint').hidden = false;
  timeline.setPeaks(null);
  renderVideoInfo();
  const banner = $('#reloadBanner');
  banner.hidden = true;
  if (!p.video) return;
  const stored = await db.get('videos', p.id).catch(() => null);
  if (stored?.blob) {
    const f = new File([stored.blob], stored.name, { type: stored.type, lastModified: stored.lastModified });
    await loadVideoFile(f, null, { fromRestore: true });
    return;
  }
  const h = (await db.get('handles', p.id).catch(() => null))?.handle;
  if (h) {
    try {
      if ((await h.queryPermission({ mode: 'read' })) === 'granted') { await loadVideoFile(await h.getFile(), h, { fromRestore: true }); return; }
    } catch { /* 下の案内へ */ }
  }
  banner.innerHTML = `<span>🎞 動画「<b>${escapeHtml(p.video.name)}</b>」（${fmtBytes(p.video.size)}）を再度読み込んでください。</span>
    ${h ? '<button class="btn sm primary" data-act="grant">アクセスを許可して開く</button>' : ''}
    <button class="btn sm" data-act="pick">ファイルを選択</button>
    <button class="banner-close" data-act="close" title="閉じる（右パネルの「動画情報」から再表示できます）" aria-label="閉じる">✕</button>`;
  banner.hidden = false;
  banner.onclick = async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { banner.hidden = true; renderVideoInfo(); return; } // 閉じるだけ（編集データには触れない）
    if (act === 'pick') openVideoDialog();
    if (act === 'grant') {
      try {
        if ((await h.requestPermission({ mode: 'read' })) === 'granted') await loadVideoFile(await h.getFile(), h, { fromRestore: true });
      } catch (err) { toast('ファイルを開けませんでした。ファイルを選択してください', true); }
    }
  };
}

async function computeWaveform(file) {
  timeline.waveMsg = '波形を解析中…';
  timeline.setPeaks(null);
  if (file.size > 600 * 1024 ** 2) { timeline.waveMsg = '動画が大きいため波形表示を省略しました'; timeline.drawCanvases(); return; }
  try {
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    if (S.file !== file) return;
    const perSec = 100, bucket = buf.sampleRate / perSec;
    const n = Math.ceil(buf.length / bucket);
    const peaks = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) {
        let m = peaks[i];
        const end = Math.min(d.length, (i + 1) * bucket);
        for (let j = Math.floor(i * bucket); j < end; j++) { const v = Math.abs(d[j]); if (v > m) m = v; }
        peaks[i] = m;
      }
    }
    let max = 0;
    for (const v of peaks) if (v > max) max = v;
    if (max > 0) for (let i = 0; i < n; i++) peaks[i] = Math.sqrt(peaks[i] / max);
    timeline.setPeaks(peaks, perSec);
  } catch (e) {
    timeline.waveMsg = '音声波形を取得できませんでした';
    timeline.drawCanvases();
  }
}

function aspectLabel(w, h) {
  if (!w || !h) return '';
  const r = w / h;
  const known = [[9 / 16, '9:16（縦）'], [16 / 9, '16:9（横）'], [1, '1:1（正方形）'], [4 / 3, '4:3'], [3 / 4, '3:4（縦）'], [4 / 5, '4:5（縦）'], [21 / 9, '21:9']];
  for (const [v, l] of known) if (Math.abs(r - v) < 0.02) return l;
  return `${r.toFixed(3)}:1`;
}

function renderVideoInfo() {
  const p = P(), v = p.video, el = $('#videoInfo');
  if (!v) { el.innerHTML = '動画が読み込まれていません'; return; }
  const pr = S.probe;
  el.innerHTML = `
    <div><b style="color:var(--fg)">${escapeHtml(v.name)}</b></div>
    <div>${v.width}×${v.height}　${aspectLabel(v.width, v.height)}</div>
    <div>${fmtTime(v.duration)}　${fmtBytes(v.size)}</div>
    ${pr ? (pr.error ? `<div style="color:var(--warn)">解析: ${escapeHtml(pr.error)}</div>` : `<div>映像 ${escapeHtml(pr.vcodec || '-')}${pr.rotation ? `（回転 ${pr.rotation}°）` : ''} ${pr.fps ? pr.fps.toFixed(2) + 'fps' : ''}<br>音声 ${escapeHtml(pr.acodec || 'なし')}${pr.decodable === false ? '<br><span style="color:var(--warn)">※この映像コーデックは高速書き出し非対応（実時間で書き出します）</span>' : ''}</div>`) : ''}
    ${S.file ? '' : `<div style="color:var(--warn)">動画ファイルが未読み込みです${$('#reloadBanner').hidden && $('#reloadBanner').innerHTML ? ' <button class="btn sm" id="btnShowReload">再読み込みの案内を表示</button>' : ''}</div>`}
    <label class="inline" style="margin-top:6px;color:var(--fg)"><input type="checkbox" id="storeVideo" ${p.editor.storeVideo ? 'checked' : ''}> 動画をブラウザ内にも保存（再選択不要）</label>
    <div class="muted" style="font-size:11px">オフ: 動画の情報だけを保存し、次回は同じファイルを再選択（またはアクセス許可）して読み込みます。</div>
    <div><button class="btn sm" id="btnReselect">動画を選び直す</button></div>`;
  $('#storeVideo').onchange = async e => {
    p.editor.storeVideo = e.target.checked;
    if (p.editor.storeVideo) {
      if (S.file && S.file.size > 2 * 1024 ** 3 && !(await confirmDialog(`動画が大きいです（${fmtBytes(S.file.size)}）。ブラウザ内に保存しますか？`, { ok: '保存する' }))) { p.editor.storeVideo = false; e.target.checked = false; return; }
      storeVideoBlob();
    } else {
      await db.delete('videos', p.id).catch(() => {});
      toast('ブラウザ内の動画を削除しました');
    }
    S.dirty = true; autosave();
  };
  $('#btnReselect').onclick = openVideoDialog;
  $('#btnShowReload') && ($('#btnShowReload').onclick = () => { $('#reloadBanner').hidden = false; renderVideoInfo(); });
}

// ============================================================
// プレビュー（ステージサイズ・字幕オーバーレイ）
// ============================================================
function fitStage() {
  const wrap = $('#stageWrap');
  const vw = video.videoWidth || P()?.video?.width || 16, vh = video.videoHeight || P()?.video?.height || 9;
  const aw = wrap.clientWidth - 20, ah = wrap.clientHeight - 20;
  if (aw <= 0 || ah <= 0) return;
  let w, h;
  if (aw / ah > vw / vh) { h = ah; w = h * vw / vh; } else { w = aw; h = w * vh / vw; }
  w = Math.floor(w); h = Math.floor(h);
  const st = $('#stage');
  st.style.width = `${w}px`;
  st.style.height = `${h}px`;
  if (w !== S.stageW || h !== S.stageH) { S.stageW = w; S.stageH = h; S.overlayKey = null; renderOverlay(true); }
}

function fontFamilyFor(style) {
  if (!style.customFontId) return style.fontFamily;
  const f = S.fonts.find(x => x.id === style.customFontId);
  return f ? `"${f.family}", ${DEFAULT_STYLE.fontFamily}` : style.fontFamily;
}

function renderOverlay(force = false) {
  const ov = $('#overlay');
  const p = P();
  if (!p || !S.stageW) return; // 起動直後（プロジェクト読み込み前）は何もしない
  const t = video.currentTime || 0;
  const cue = activeCueAt(S.recordCues || S.cues, t);
  const style = p.style;
  const key = cue ? `${cue.lineId}|${cue.text}|${S.stageW}x${S.stageH}` : null;
  if (key !== S.overlayKey) {
    S.overlayKey = key;
    ov.innerHTML = '';
    S.overlayEl = null;
    if (cue) {
      const el = createCueElement(document, cue.text, style, S.stageW, S.stageH, fontFamilyFor(style));
      el.classList.add('cue');
      ov.appendChild(el);
      const bw = el.offsetWidth, bh = el.offsetHeight;
      const pos = layoutBox(bw, bh, S.stageW, S.stageH, style);
      el.style.left = `${pos.x}px`;
      el.style.top = `${pos.y}px`;
      S.overlayEl = el;
      S.overlayBox = { bw, bh };
    }
  }
  if (S.overlayEl && cue) {
    const st = animState(t, cue.start, cue.end, style);
    const k = Math.min(S.stageW, S.stageH) / 1080;
    const el = S.overlayEl;
    el.style.opacity = String(st.opacity);
    el.style.transform = `translateY(${st.dy * k}px) scale(${st.scale})`;
    const pad = (style.strokeWidth * 2 + style.shadowBlur * 2 + Math.abs(style.shadowX) + Math.abs(style.shadowY) + 8) * k;
    el.style.clipPath = style.animation === 'wipe' ? wipeClip(st.reveal, style.writingMode === 'vertical', S.overlayBox.bw, S.overlayBox.bh, pad) : '';
  }
  // 再生中の行・ブロックのハイライト
  const activeId = cue?.lineId || null;
  if (activeId !== S.activeLineId) {
    S.activeLineId = activeId;
    $$('#lineList .line.active').forEach(e => e.classList.remove('active'));
    if (activeId) $(`#lineList .line[data-id="${activeId}"]`)?.classList.add('active');
    timeline.setActive(activeId);
  }
}

function loop() {
  const t = video.currentTime || 0;
  if (S.file) {
    $('#timeCur').textContent = fmtTime(t);
    $('#tlTime').textContent = fmtTime(t);
    if (!seekDragging) updateSeekBar(t);
    timeline.setTime(t, !video.paused);
    renderOverlay();
  }
  const playing = !video.paused && !video.ended;
  const icon = playing ? '❚❚' : '▶';
  if ($('#btnPlay').textContent !== icon) { $('#btnPlay').textContent = icon; $('#btnPlay2').textContent = icon; }
  requestAnimationFrame(loop);
}

// ============================================================
// 歌詞・タイミング一覧（左パネル）
// ============================================================
function renderLyricHead() {
  const p = P();
  $('#lyricTitle').textContent = p.lyricTitle || (p.lines.length ? '（無題の歌詞）' : '歌詞が未設定です');
}

function renderLines() {
  const p = P();
  renderLyricHead();
  const list = $('#lineList');
  $('#lineEmpty').hidden = p.lines.length > 0;
  list.hidden = p.lines.length === 0;
  const cueMap = new Map(S.cues.map(c => [c.lineId, c]));
  const scroll = list.scrollTop;
  list.innerHTML = p.lines.map((l, i) => {
    const c = cueMap.get(l.id);
    const t = p.timings[l.id];
    const sel = l.id === S.selectedId;
    const cls = ['line', c ? 'recorded' : '', i === p.editor.cursor ? 'cursor' : '', sel ? 'selected' : '', l.id === S.activeLineId ? 'active' : ''].join(' ');
    const timeText = c ? `${fmtTime(c.start)}` : (i === p.editor.cursor ? '次に記録' : '未記録');
    let edit = '';
    if (sel) {
      const endVal = t?.end != null ? fmtTime(t.end) : '';
      const endPh = c && isFinite(c.end) ? `自動 ${fmtTime(c.end)}` : '自動';
      edit = `<div class="line-edit">
        <div class="adj"><span class="adj-label">開始</span><div class="adj-row">
          <button class="btn" data-a="nudge" data-f="start" data-d="-0.1">−0.1</button><button class="btn" data-a="nudge" data-f="start" data-d="-0.01">−.01</button>
          <input data-f="start" value="${c ? fmtTime(c.start) : ''}" placeholder="未記録">
          <button class="btn" data-a="nudge" data-f="start" data-d="0.01">+.01</button><button class="btn" data-a="nudge" data-f="start" data-d="0.1">+0.1</button>
          <button class="btn" data-a="setNow" data-f="start" title="現在の再生位置を開始時刻にする">現在</button></div></div>
        <div class="adj"><span class="adj-label">終了</span><div class="adj-row">
          <button class="btn" data-a="nudge" data-f="end" data-d="-0.1">−0.1</button><button class="btn" data-a="nudge" data-f="end" data-d="-0.01">−.01</button>
          <input data-f="end" value="${endVal}" placeholder="${endPh}">
          <button class="btn" data-a="nudge" data-f="end" data-d="0.01">+.01</button><button class="btn" data-a="nudge" data-f="end" data-d="0.1">+0.1</button>
          <button class="btn" data-a="setNow" data-f="end" title="現在の再生位置を終了時刻にする">現在</button><button class="btn" data-a="endAuto" title="次の歌詞の開始まで表示">自動</button></div></div>
        <div class="line-actions">
          <button class="btn" data-a="play" ${c ? '' : 'disabled'}>▶ ここから再生</button>
          <button class="btn" data-a="cursorHere">● ここから記録</button>
          <button class="btn" data-a="clearTiming" ${c ? '' : 'disabled'}>タイミング消去</button>
        </div>
        <div class="line-actions">
          <button class="btn" data-a="mergeNext" ${i < p.lines.length - 1 ? '' : 'disabled'} title="次の行とつなげて1行にする">⤓ 次の行と結合</button>
          <button class="btn" data-a="insertBelow">＋ 下に行を追加</button>
          <button class="btn" data-a="section" title="この行から始まるセクション（Aメロ・サビなど）の名前">🏷 ${l.section ? 'セクション名' : 'ここからセクション'}</button>
          <button class="btn" data-a="up" title="上へ移動">↑</button><button class="btn" data-a="down" title="下へ移動">↓</button>
        </div></div>`;
    }
    const head = l.section ? `<li class="sec-head" data-id="${l.id}" title="クリックで名前を変更">🏷 ${escapeHtml(l.section)}</li>` : '';
    return `${head}<li class="${cls}" data-id="${l.id}">
      <div class="line-main"><span class="line-handle" draggable="true" title="ドラッグで並べ替え">⋮⋮</span><span class="line-no">${i + 1}</span><span class="line-dot"></span>
      <span class="line-text">${escapeHtml(l.text)}</span><span class="line-time">${timeText}</span>
      <button class="line-rec" data-a="cursorHere" title="${i === p.editor.cursor ? 'ここから記録します' : 'この行から記録を始める（記録済みの行も記録し直せます）'}">${i === p.editor.cursor ? '● 記録位置' : '● ここから'}</button></div>${edit}</li>`;
  }).join('');
  list.scrollTop = scroll;
}

function scrollLineIntoView(id) {
  const el = id && $(`#lineList .line[data-id="${id}"]`);
  if (!el) return;
  // ページ全体はスクロールさせず、歌詞一覧の中だけをスクロールする（スマホで記録ボタンの位置がずれないように）
  const list = $('#lineList');
  const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop, bottom = top + el.offsetHeight;
  if (top < list.scrollTop) list.scrollTo({ top: top - 8, behavior: 'smooth' });
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTo({ top: bottom - list.clientHeight + 8, behavior: 'smooth' });
}

function selectLine(id, { seek = true } = {}) {
  S.selectedId = id;
  timeline.setSelected(id);
  renderLines();
  updateCueActions();
  const t = P().timings[id];
  if (seek && t?.start != null) seekTo(t.start);
  scrollLineIntoView(id);
}

function setTiming(id, field, value) {
  const p = P();
  const t = p.timings[id] || (p.timings[id] = { start: null, end: null });
  if (field === 'start') {
    if (value == null) { delete p.timings[id]; return; }
    t.start = +Math.max(0, value).toFixed(3);
    if (t.end != null && t.end <= t.start) t.end = null;
  } else {
    if (t.start == null) { toast('先に開始時刻を記録してください', true); return; }
    t.end = value == null ? null : +Math.max(t.start + 0.01, value).toFixed(3);
  }
}

function moveLine(from, to) {
  const p = P();
  if (to < 0 || to >= p.lines.length || from === to) return;
  pushUndo('歌詞の並べ替え');
  const cursorId = p.lines[p.editor.cursor]?.id;
  const [l] = p.lines.splice(from, 1);
  p.lines.splice(to, 0, l);
  // 記録位置は「行」に紐づけて維持（タイミングは行IDに紐づくため並べ替えで崩れない）
  if (cursorId) p.editor.cursor = p.lines.findIndex(x => x.id === cursorId);
  changed();
}

/**
 * 記録を始める位置（行）を指定する。記録済みの行も選べ、記録するとその行のタイミングを上書きする。
 * 記録済みの行なら、その少し前に再生位置を戻して記録し直しやすくする。
 */
function setRecordStart(idx) {
  const p = P();
  const line = p.lines[idx];
  if (!line) return;
  p.editor.cursor = idx;
  changed();
  const t = p.timings[line.id];
  const prev = idx > 0 ? p.timings[p.lines[idx - 1].id] : null;
  const how = S.recordMode ? '' : '（「● 記録開始」で記録モードにしてください）';
  if (S.file && t?.start != null) {
    if (!S.recordMode) seekTo(Math.max(0, t.start - 2));
    toast(`${idx + 1}行目から記録し直します${how}。記録すると今のタイミングは上書きされます`);
  } else {
    if (S.file && !S.recordMode && prev?.start != null) seekTo(prev.start);
    toast(`${idx + 1}行目から記録します${how}`);
  }
}

function setupLineList() {
  const list = $('#lineList');
  list.addEventListener('click', e => {
    const sh = e.target.closest('.sec-head');
    if (sh) { editSection(sh.dataset.id); return; }
    const li = e.target.closest('.line');
    if (!li) return;
    const id = li.dataset.id, p = P();
    const idx = p.lines.findIndex(l => l.id === id);
    const btn = e.target.closest('button[data-a]');
    if (btn) {
      const a = btn.dataset.a, f = btn.dataset.f;
      const cue = S.cues.find(c => c.lineId === id);
      if (a === 'nudge') {
        const cur = f === 'start' ? cue?.start : (p.timings[id]?.end ?? cue?.end);
        if (cur == null || !isFinite(cur)) { toast('先に開始時刻を記録してください', true); return; }
        pushUndo('タイミングの微調整', true);
        setTiming(id, f, cur + Number(btn.dataset.d));
        changed();
        if (f === 'start') seekTo(p.timings[id].start); else seekTo(Math.max(0, p.timings[id].end - 1));
      } else if (a === 'setNow') {
        if (!S.file) { toast('動画を読み込んでください', true); return; }
        pushUndo('タイミングを現在位置に');
        setTiming(id, f, video.currentTime);
        changed();
      } else if (a === 'endAuto') {
        if (p.timings[id]) { pushUndo('終了を自動に'); p.timings[id].end = null; changed(); }
      } else if (a === 'play') {
        if (cue) { seekTo(cue.start); video.play(); }
      } else if (a === 'cursorHere') {
        setRecordStart(idx);
      } else if (a === 'clearTiming') {
        pushUndo(`${idx + 1}行目のタイミング消去`);
        removeCuesKeepingGaps(p.lines, p.timings, video.duration || p.video?.duration, [id]);
        changed();
      } else if (a === 'up') moveLine(idx, idx - 1);
      else if (a === 'down') moveLine(idx, idx + 1);
      else if (a === 'mergeNext') mergeWithNext(idx);
      else if (a === 'section') editSection(id);
      else if (a === 'insertBelow') {
        pushUndo('行の追加');
        const nl = { id: uid('l_'), text: '（新しい行）' };
        p.lines.splice(idx + 1, 0, nl);
        if (p.editor.cursor > idx) p.editor.cursor++;
        S.selectedId = nl.id;
        changed();
        startInlineEdit($(`#lineList .line[data-id="${nl.id}"]`), nl.id);
      }
      return;
    }
    if (e.target.closest('.line-edit, .text-edit') || e.target.tagName === 'INPUT') return;
    selectLine(id === S.selectedId ? id : id);
  });
  list.addEventListener('dblclick', e => {
    const li = e.target.closest('.line');
    if (li && e.target.closest('.line-text')) startInlineEdit(li, li.dataset.id);
  });
  // 時刻入力欄（Enter / フォーカス外れで確定）
  const commitInput = inp => {
    const li = inp.closest('.line');
    if (!li || !inp.dataset.f) return;
    const id = li.dataset.id, f = inp.dataset.f, p = P();
    const raw = inp.value.trim();
    const cur = f === 'start' ? p.timings[id]?.start : p.timings[id]?.end;
    if (raw === '' && f === 'end') { if (cur != null) { pushUndo('終了を自動に'); p.timings[id].end = null; changed(); } return; }
    if (raw === '' && f === 'start') { if (cur != null) { pushUndo('タイミング消去'); delete p.timings[id]; changed(); } return; }
    const v = parseTime(raw);
    if (v == null) { toast('時刻の形式が正しくありません（例: 1:23.456）', true); renderLines(); return; }
    if (cur != null && Math.abs(cur - v) < 0.0005) return;
    pushUndo('タイミングの手動入力');
    setTiming(id, f, v);
    changed();
  };
  list.addEventListener('keydown', e => {
    if (e.target.matches('input[data-f]') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    if (e.target.matches('input[data-f]') && e.key === 'Escape') { renderLines(); }
  });
  list.addEventListener('focusout', e => { if (e.target.matches('input[data-f]')) commitInput(e.target); });

  // ドラッグで並べ替え
  let dragId = null;
  list.addEventListener('dragstart', e => {
    const li = e.target.closest('.line');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  list.addEventListener('dragover', e => {
    if (!dragId) return;
    e.preventDefault();
    $$('#lineList .drop-before').forEach(x => x.classList.remove('drop-before'));
    e.target.closest('.line')?.classList.add('drop-before');
  });
  list.addEventListener('dragend', () => { dragId = null; renderLines(); });
  list.addEventListener('drop', e => {
    e.preventDefault();
    const li = e.target.closest('.line');
    const p = P();
    if (!dragId) return;
    const from = p.lines.findIndex(l => l.id === dragId);
    let to = li ? p.lines.findIndex(l => l.id === li.dataset.id) : p.lines.length - 1;
    if (from < to) to--;
    dragId = null;
    if (from !== to) moveLine(from, Math.max(0, to)); else renderLines();
  });
}

/** 一覧上で行の文字を修正（ダブルクリック・行の追加時） */
function startInlineEdit(li, id) {
  const p = P();
  const line = p.lines.find(l => l.id === id);
  const span = li?.querySelector('.line-text');
  if (!span || !line) return;
  const box = document.createElement('div');
  box.className = 'text-edit';
  box.innerHTML = `<input class="inline-edit" enterkeyhint="done">
    <div class="text-edit-btns">
      <button type="button" class="btn sm primary" data-te="ok">✓ 確定</button>
      <button type="button" class="btn sm ghost" data-te="cancel">キャンセル</button>
    </div>`;
  const inp = box.querySelector('input');
  inp.value = line.text;
  span.replaceWith(box);
  inp.focus();
  inp.setSelectionRange(line.text.length, line.text.length);
  let done = false;
  const finish = act => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (act === 'ok' && v && v !== line.text) { pushUndo('歌詞の修正'); line.text = v; changed(); } else renderLines();
  };
  // ボタンを押してもフォーカスが外れない（カーソル位置が保たれる）ようにする
  box.querySelectorAll('button').forEach(b => {
    b.addEventListener('pointerdown', e => e.preventDefault());
    b.addEventListener('click', e => { e.stopPropagation(); finish(b.dataset.te); });
  });
  inp.addEventListener('click', e => e.stopPropagation());
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) finish('ok'); if (e.key === 'Escape') finish('cancel'); });
  inp.addEventListener('blur', () => setTimeout(() => { if (!box.contains(document.activeElement)) finish('ok'); }, 0));
}

/**
 * 選んだブロックを再生位置（赤い線）で2つに分ける。歌詞の文字はそのまま同じものが2つになる。
 * 前半：元の開始〜再生位置、後半：再生位置〜元の終了
 */
function splitCueAtPlayhead() {
  const p = P();
  const idx = p.lines.findIndex(l => l.id === S.selectedId);
  const line = p.lines[idx];
  if (!line) { toast('先にタイムラインのブロックを選んでください', true); return; }
  const cue = S.cues.find(c => c.lineId === line.id);
  if (!cue) { toast('この歌詞はまだ記録されていないため分割できません', true); return; }
  const t = video.currentTime;
  if (!(t > cue.start + 0.05 && t < cue.end - 0.05)) {
    toast('赤い線（再生位置）を分けたいブロックの中に合わせてから押してください', true);
    return;
  }
  pushUndo(`${idx + 1}行目のブロック分割`);
  const nl = { id: uid('l_'), text: line.text };
  p.lines.splice(idx + 1, 0, nl);
  const tm = p.timings[line.id];
  p.timings[nl.id] = { start: +t.toFixed(3), end: tm.end ?? null };
  tm.end = null; // 前半の終了は後半の開始（再生位置）に合わせて自動
  if (p.editor.cursor > idx) p.editor.cursor++;
  S.selectedId = nl.id;
  timeline.setSelected(nl.id);
  changed();
  toast(`ブロックを ${fmtTime(t)} で2つに分割しました`);
}

// ---------------- タイムラインの「修正・分割・削除」 ----------------
/** タイムライン上部の操作ボタンを、選択中の歌詞に合わせて更新 */
function updateCueActions() {
  const p = P();
  const idx = p ? p.lines.findIndex(l => l.id === S.selectedId) : -1;
  const line = p?.lines[idx];
  $('#tlSel').classList.toggle('active', !!line);
  $('#tlSelLabel').textContent = line ? `${idx + 1}. ${line.text}` : 'ブロックを選ぶと修正・分割・削除できます';
  $('#tlSelLabel').title = line ? line.text : '';
  ['#btnCueEdit', '#btnCueSplit', '#btnCueDelete'].forEach(b => { $(b).disabled = !line; });
}

/** 選んだ歌詞の文字を修正するダイアログ */
function openCueTextDialog() {
  const p = P();
  const idx = p.lines.findIndex(l => l.id === S.selectedId);
  const line = p.lines[idx];
  if (!line) { toast('先にタイムラインのブロック（または歌詞の行）を選んでください', true); return; }
  openModal(`
    <div class="modal-head">${idx + 1}行目を修正<button class="btn ghost sm" data-close>✕</button></div>
    <div class="modal-body">
      <label class="block"><span>歌詞</span><input id="cueText" enterkeyhint="done" autocomplete="off"></label>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="cueOk">保存</button>
    </div>`);
  const inp = $('#cueText');
  inp.value = line.text;
  setTimeout(() => { inp.focus(); inp.setSelectionRange(line.text.length, line.text.length); }, 50);
  const commit = () => {
    const v = inp.value.trim();
    closeModal();
    if (v && v !== line.text) { pushUndo('歌詞の修正'); line.text = v; changed(); }
  };
  $('#cueOk').onclick = commit;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); commit(); } });
}

/** この行から始まるセクションの名前を付ける・変える（空にするとセクションを外す） */
async function editSection(id) {
  const p = P();
  const l = p.lines.find(x => x.id === id);
  if (!l) return;
  const v = await promptDialog('セクション名（例：Aメロ、Bメロ、サビ）。空にするとセクションを外します', l.section || '', { ok: '決定' });
  if (v == null) return;
  const name = v.trim().replace(/^[[［【]|[\]］】]$/g, '').trim().slice(0, 40);
  if ((l.section || '') === name) return;
  pushUndo(name ? 'セクション名の設定' : 'セクションを外す');
  if (name) l.section = name; else delete l.section;
  changed();
}

/** 選んだ歌詞（行とタイミング）を削除 */
function deleteSelectedCue() {
  const p = P();
  const idx = p.lines.findIndex(l => l.id === S.selectedId);
  if (idx < 0) { toast('先にタイムラインのブロック（または歌詞の行）を選んでください', true); return; }
  const id = p.lines[idx].id;
  pushUndo(`${idx + 1}行目の削除`);
  // 削除した区間は空白のまま残す（前のブロックの終了を延ばさない・後のブロックの開始も変えない）
  removeCuesKeepingGaps(p.lines, p.timings, video.duration || p.video?.duration, [id]);
  // セクションの最初の行を消したときは、セクションを次の行に引き継ぐ
  const nextLine = p.lines[idx + 1];
  if (p.lines[idx].section && nextLine && !nextLine.section) nextLine.section = p.lines[idx].section;
  p.lines.splice(idx, 1);
  if (p.editor.cursor > idx) p.editor.cursor--;
  p.editor.cursor = Math.min(p.editor.cursor, p.lines.length);
  S.selectedId = null;
  timeline.setSelected(null);
  changed();
  toast(`${idx + 1}行目を削除しました（↶ 取り消しで元に戻せます）`);
}

/** 次の行とつなげて1行にする。タイミングは前の行のものを使う */
function mergeWithNext(idx) {
  const p = P();
  const a = p.lines[idx], b = p.lines[idx + 1];
  if (!a || !b) return;
  pushUndo(`${idx + 1}行目と${idx + 2}行目の結合`);
  const sep = /[A-Za-z0-9]$/.test(a.text) && /^[A-Za-z0-9]/.test(b.text) ? ' ' : '';
  a.text = a.text + sep + b.text;
  if (p.timings[b.id]?.end != null && p.timings[a.id]) p.timings[a.id].end = p.timings[b.id].end;
  delete p.timings[b.id];
  p.lines.splice(idx + 1, 1);
  if (p.editor.cursor > idx + 1) p.editor.cursor--;
  p.editor.cursor = Math.min(p.editor.cursor, p.lines.length);
  S.selectedId = a.id;
  changed();
}

// ============================================================
// 歌詞ライブラリ
// ============================================================
async function loadLibrary() {
  S.library = (await db.getAll('lyrics')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || b.updatedAt - a.updatedAt);
}

async function saveLyricSet(set) {
  set.updatedAt = Date.now();
  await db.put('lyrics', deepClone(set));
  await loadLibrary();
  libChannel?.postMessage({ type: 'libraryChanged' });
}

function setupLibrary() {
  $('#btnOpenLibrary').onclick = goLibrary;
  $('#btnEmptyLib').onclick = goLibrary;
  $('#btnEmptyNew').onclick = openLyricsEditor;
  // 別タブの歌詞ライブラリからの「この歌詞を使う」
  libChannel?.addEventListener('message', async e => {
    if (e.data?.type === 'libraryChanged') { await loadLibrary(); return; }
    if (e.data?.type === 'useLyricSet') {
      libChannel.postMessage({ type: 'ack', id: e.data.id });
      try { localStorage.removeItem(PENDING_KEY); } catch { /* 無視 */ }
      await loadLibrary();
      const set = S.library.find(x => x.id === e.data.id);
      if (set) useLyricSet(set);
    }
  });
}

async function goLibrary() {
  if (S.dirty) await saveProject(false);
  openLibraryPage();
}

/** エディタが閉じていた間にライブラリで「この歌詞を使う」が押されていたら読み込む */
async function applyPendingLyricSet() {
  let pending = null;
  try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); localStorage.removeItem(PENDING_KEY); } catch { /* 無視 */ }
  if (!pending || Date.now() - pending.at > 30 * 60 * 1000) return;
  await loadLibrary();
  const set = S.library.find(x => x.id === pending.id);
  if (set) useLyricSet(set);
}

async function useLyricSet(set) {
  const p = P();
  const hasTimings = p.lines.some(l => p.timings[l.id]?.start != null);
  if (p.lyricSetId === set.id && hasTimings) {
    // 同じ歌詞の最新版に同期（行IDが同じ行のタイミングは維持）
    pushUndo('歌詞をライブラリと同期');
    p.lines = set.lines.map(l => ({ ...l }));
  } else {
    if (hasTimings && !(await confirmDialog(`現在の歌詞とタイミングを「${set.title}」に置き換えますか？\n（↶ 取り消しで元に戻せます）`, { ok: '置き換える' }))) return;
    pushUndo('歌詞の読み込み');
    p.lines = set.lines.map(l => ({ ...l }));
    p.timings = {};
  }
  p.lyricSetId = set.id;
  p.lyricTitle = set.title;
  cleanupTimings();
  p.editor.cursor = firstUnrecorded(p.lines, p.timings);
  S.selectedId = null;
  if (!p.name || p.name === '新しいプロジェクト') { p.name = set.title; $('#projectName').value = p.name; }
  changed();
  saveProject(false).then(() => libChannel?.postMessage({ type: 'projectChanged' }));
  toast(`歌詞「${set.title}」を読み込みました（${set.lines.length}行）`);
}

function cleanupTimings() {
  const p = P(), ids = new Set(p.lines.map(l => l.id));
  for (const id of Object.keys(p.timings)) if (!ids.has(id)) delete p.timings[id];
}

/** このプロジェクトの歌詞をテキストでまとめて編集（ライブラリ未登録なら新規登録する） */
function openLyricsEditor() {
  const p = P();
  const title = p.lyricTitle || '';
  const artist = S.library.find(s => s.id === p.lyricSetId)?.artist || '';
  openModal(`
    <div class="modal-head">${p.lines.length ? 'このプロジェクトの歌詞を編集' : '歌詞を入力'}<button class="btn ghost sm" data-close>✕</button></div>
    <div class="modal-body">
      <label class="block"><span>楽曲名</span><input id="edTitle" value="${escapeHtml(title)}" placeholder="例：朝焼けのカーテン"></label>
      <label class="block"><span>アーティスト（任意）</span><input id="edArtist" value="${escapeHtml(artist)}"></label>
      <label class="block"><span>歌詞（1行＝1字幕。空行は無視されます。<b>[Aメロ]</b> のように括弧だけの行を書くと、次の行からがそのセクションになります）</span>
        <textarea id="edLines" placeholder="[Aメロ]&#10;もう朝焼けがカーテンを染める&#10;君のいない部屋で目を覚ます&#10;&#10;[サビ]&#10;昨日の続きを探している">${escapeHtml(lyricsToText(p.lines))}</textarea></label>
      <div class="muted small" id="edCount"></div>
      ${p.lyricSetId ? '<label class="inline"><input type="checkbox" id="edSyncLib" checked> 歌詞ライブラリにも反映する</label>' : '<div class="muted small">保存すると歌詞ライブラリにも登録されます。</div>'}
      <div class="muted small">本文が同じ行・同じ位置の行は、記録済みのタイミングを引き継ぎます。</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn primary" id="edSave">保存</button>
    </div>`);
  const ta = $('#edLines');
  const count = () => { const x = parseLyricsText(ta.value); const n = x.filter(l => l.section).length; $('#edCount').textContent = `${x.length} 行${n ? `・セクション ${n} 個` : ''}`; };
  ta.addEventListener('input', count);
  count();
  setTimeout(() => (title ? ta : $('#edTitle')).focus(), 50);

  $('#edSave').onclick = async () => {
    const texts = parseLyricsText(ta.value);
    const t = $('#edTitle').value.trim() || '無題の歌詞';
    const ar = $('#edArtist').value.trim();
    if (!texts.length) { toast('歌詞を1行以上入力してください', true); return; }
    pushUndo('歌詞の編集');
    const cursorId = p.lines[p.editor.cursor]?.id;
    p.lines = mergeLyricsText(p.lines, ta.value);
    p.lyricTitle = t;
    cleanupTimings();
    const ci = cursorId ? p.lines.findIndex(l => l.id === cursorId) : -1;
    p.editor.cursor = ci >= 0 ? ci : firstUnrecorded(p.lines, p.timings);
    if ($('#edSyncLib')?.checked) {
      const lib = S.library.find(s => s.id === p.lyricSetId);
      if (lib) { lib.title = t; lib.artist = ar; lib.lines = p.lines.map(l => ({ ...l })); await saveLyricSet(lib); }
    } else if (!p.lyricSetId) {
      const ns = { id: uid('s_'), title: t, artist: ar, lines: p.lines.map(l => ({ ...l })), createdAt: Date.now(), order: S.library.length };
      await saveLyricSet(ns);
      p.lyricSetId = ns.id;
    }
    if (!p.name || p.name === '新しいプロジェクト') { p.name = t; $('#projectName').value = t; }
    closeModal();
    changed();
  };
}


// ============================================================
// 字幕デザイン（右パネル）
// ============================================================
const STYLE_FIELDS = [
  { type: 'sizeStep' },
  { key: 'writingMode', label: '方向', type: 'seg', options: [['horizontal', '横書き'], ['vertical', '縦書き']] },
  { key: 'fontFamily', label: 'フォント', type: 'font' },
  { key: 'fontSize', label: 'サイズ', type: 'range', min: 16, max: 240, step: 1, unit: 'px' },
  { key: 'fontWeight', label: '太さ', type: 'select', options: [[300, '細'], [400, '標準'], [500, '中'], [600, '中太'], [700, '太'], [800, '極太'], [900, '最太']] },
  { key: 'color', label: '文字色', type: 'color' },
  { key: 'letterSpacing', label: '字間', type: 'range', min: -0.1, max: 0.6, step: 0.01, unit: 'em' },
  { key: 'lineHeight', label: '行間', type: 'range', min: 1, max: 2.5, step: 0.05 },
  { key: 'maxSize', label: '最大の長さ', type: 'range', min: 30, max: 100, step: 1, unit: '%', hint: '超えると折り返し' },
  { sub: '縦書き', showIf: s => s.writingMode === 'vertical' },
  { key: 'tcy', label: '縦中横', type: 'check', text: '2桁までの数字を横に並べる', showIf: s => s.writingMode === 'vertical' },
  { key: 'latinUpright', label: '英字', type: 'check', text: '英字も1文字ずつ正立させる', showIf: s => s.writingMode === 'vertical' },
  { sub: '縁取り' },
  { key: 'strokeWidth', label: '太さ', type: 'range', min: 0, max: 20, step: 0.5, unit: 'px' },
  { key: 'strokeColor', label: '色', type: 'color' },
  { sub: '影' },
  { key: 'shadowEnabled', label: '影', type: 'check', text: '影をつける' },
  { key: 'shadowColor', label: '色', type: 'color' },
  { key: 'shadowOpacity', label: '濃さ', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'shadowBlur', label: 'ぼかし', type: 'range', min: 0, max: 40, step: 1, unit: 'px' },
  { key: 'shadowX', label: '横ずれ', type: 'range', min: -20, max: 20, step: 1, unit: 'px' },
  { key: 'shadowY', label: '縦ずれ', type: 'range', min: -20, max: 20, step: 1, unit: 'px' },
  { sub: '背景' },
  { key: 'bgMode', label: '背景', type: 'seg', options: [['none', 'なし'], ['box', 'ボックス'], ['band', '帯']] },
  { key: 'bgColor', label: '色', type: 'color' },
  { key: 'bgOpacity', label: '不透明度', type: 'range', min: 0, max: 1, step: 0.05 },
  { key: 'bgPadding', label: '余白', type: 'range', min: 0, max: 80, step: 1, unit: 'px' },
  { key: 'bgRadius', label: '角丸', type: 'range', min: 0, max: 60, step: 1, unit: 'px' },
  { sub: '位置' },
  { type: 'pospad' },
  { key: 'posX', label: '横位置', type: 'range', min: 0, max: 100, step: 0.5, unit: '%' },
  { key: 'posY', label: '縦位置', type: 'range', min: 0, max: 100, step: 0.5, unit: '%' },
  { sub: 'アニメーション' },
  { key: 'animation', label: '表示効果', type: 'select', options: [['none', 'なし'], ['fade', 'フェード'], ['slideUp', 'スライドアップ'], ['zoom', 'ズーム'], ['wipe', 'ワイプ（文字送り）']] },
  { key: 'animIn', label: '表示時間', type: 'range', min: 0, max: 1.5, step: 0.05, unit: 's' },
  { key: 'animOut', label: '消去時間', type: 'range', min: 0, max: 1.5, step: 0.05, unit: 's' },
  { sub: 'プリセット' },
  { type: 'presets' },
];

// ↑↓ボタンで切り替える字幕サイズの段階（短辺 1080px 換算）
const SIZE_STEPS = [20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 72, 80, 88, 96, 108, 120, 136, 152, 168, 192, 216, 240];

/** 字幕サイズを1段階大きく(+1)／小さく(-1)する */
function stepFontSize(dir) {
  const s = P().style, cur = s.fontSize;
  const next = dir > 0 ? SIZE_STEPS.find(v => v > cur) : [...SIZE_STEPS].reverse().find(v => v < cur);
  if (next == null) { toast(dir > 0 ? 'これ以上大きくできません' : 'これ以上小さくできません'); return; }
  pushUndo('字幕サイズの変更', true);
  s.fontSize = next;
  syncStylePanel();
  changed({ lines: false, style: true });
}

function buildStylePanel() {
  const html = STYLE_FIELDS.map((f, i) => {
    if (f.sub) return `<div class="sub-title" data-i="${i}">${f.sub}</div>`;
    if (f.type === 'sizeStep') return `<div class="size-step" data-i="${i}"><span class="size-step-label">字幕サイズ</span>
      <button type="button" class="btn size-btn" data-size="-1" title="1段階小さく">↓ 小さく</button>
      <span class="size-val" id="sizeVal"></span>
      <button type="button" class="btn size-btn" data-size="1" title="1段階大きく">↑ 大きく</button></div>`;
    if (f.type === 'presets') return `<div class="preset-row">${Object.keys(STYLE_PRESETS).map(n => `<button class="btn preset" data-preset="${n}" title="1回押すとオン、もう1回押すとオフ">${n}</button>`).join('')}<button class="btn ghost" data-preset="__reset">初期値</button></div>`;
    if (f.type === 'pospad') return `<div data-i="${i}"><div class="pos-pad" id="posPad"><div class="dot"></div></div>
      <div class="preset-row" style="margin-top:6px"><button class="btn" data-pos="50,50">中央</button><button class="btn" data-pos="50,15">上</button><button class="btn" data-pos="50,85">下</button><button class="btn" data-pos="82,50">右（縦書き）</button><button class="btn" data-pos="18,50">左</button></div></div>`;
    let ctl = '';
    if (f.type === 'range') ctl = `<span class="inline"><input type="range" data-k="${f.key}" min="${f.min}" max="${f.max}" step="${f.step}"><span class="val" data-v="${f.key}"></span></span>`;
    if (f.type === 'color') ctl = `<span class="inline"><input type="color" data-k="${f.key}"><span class="val" data-v="${f.key}" style="width:auto"></span></span>`;
    if (f.type === 'check') ctl = `<label class="inline"><input type="checkbox" data-k="${f.key}"> <span class="small">${f.text}</span></label>`;
    if (f.type === 'select') ctl = `<select data-k="${f.key}">${f.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
    if (f.type === 'seg') ctl = `<div class="seg" data-seg="${f.key}">${f.options.map(([v, l]) => `<button data-val="${v}">${l}</button>`).join('')}</div>`;
    if (f.type === 'font') return `<label class="field" data-i="${i}"><span>${f.label}</span><select data-k="fontFamily" id="fontSelect"></select></label><div id="fontNote" class="font-note" hidden></div>`;
    return `<label class="field" data-i="${i}"><span>${f.label}</span>${ctl}</label>`;
  }).join('');
  const panel = $('#stylePanel');
  panel.innerHTML = html;

  const apply = (key, val, coalesce = true) => {
    const s = P().style;
    if (s[key] === val) return;
    pushUndo('字幕デザインの変更', coalesce);
    s[key] = val;
    syncStylePanel();
    changed({ lines: false, style: true });
  };
  panel.addEventListener('input', e => {
    const k = e.target.dataset.k;
    if (!k) return;
    const f = STYLE_FIELDS.find(x => x.key === k);
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (f?.type === 'range' || k === 'fontWeight') v = Number(v);
    if (k === 'fontFamily') {
      if (v === '__add') { syncStylePanel(); $('#fileFont').click(); return; }
      if (v === '__all') {
        syncStylePanel();
        loadAllLocalFamilies().then(fams => { syncStylePanel(); toast(`Mac のフォント ${fams.length} 種類を読み込みました`); })
          .catch(err => toast('フォント一覧を取得できませんでした: ' + err.message, true));
        return;
      }
      const s = P().style;
      pushUndo('フォントの変更');
      if (v.startsWith('custom:')) { s.customFontId = v.slice(7); } else { s.customFontId = null; s.fontFamily = v; }
      syncStylePanel();
      changed({ lines: false, style: true });
      return;
    }
    apply(k, v);
  });
  panel.addEventListener('click', e => {
    const seg = e.target.closest('[data-seg] button');
    if (seg) { apply(seg.parentElement.dataset.seg, seg.dataset.val, false); return; }
    const pre = e.target.closest('[data-preset]');
    if (pre) {
      togglePreset(pre.dataset.preset);
      return;
    }
    const sz = e.target.closest('[data-size]');
    if (sz) { stepFontSize(Number(sz.dataset.size)); return; }
    const pos = e.target.closest('[data-pos]');
    if (pos) {
      const [x, y] = pos.dataset.pos.split(',').map(Number);
      pushUndo('位置の変更');
      Object.assign(P().style, { posX: x, posY: y });
      syncStylePanel();
      changed({ lines: false, style: true });
    }
  });
  // 位置パッド（ドラッグで位置指定）
  const pad = $('#posPad');
  let dragging = false;
  const setFromPad = e => {
    const r = pad.getBoundingClientRect();
    const x = clamp((e.clientX - r.left) / r.width * 100, 0, 100), y = clamp((e.clientY - r.top) / r.height * 100, 0, 100);
    pushUndo('位置の変更', true);
    Object.assign(P().style, { posX: Math.round(x * 2) / 2, posY: Math.round(y * 2) / 2 });
    syncStylePanel();
    changed({ lines: false, style: true });
  };
  pad.addEventListener('pointerdown', e => { dragging = true; pad.setPointerCapture(e.pointerId); setFromPad(e); });
  pad.addEventListener('pointermove', e => { if (dragging) setFromPad(e); });
  pad.addEventListener('pointerup', () => { dragging = false; });
}

/**
 * プリセットのオン/オフ。1回押すとオン、もう1回押すとオフ（プリセットで変えた項目だけ押す前の値に戻す）。
 * 適用中のプリセット名と元の値は style.presetName / style.presetBase に持つ（取り消し・保存にも追従する）
 */
function togglePreset(name) {
  const s = P().style;
  if (name === '__reset') {
    pushUndo('デザインを初期値に');
    P().style = { ...DEFAULT_STYLE };
  } else if (s.presetName === name) {
    pushUndo(`プリセット「${name}」をオフ`);
    Object.assign(s, s.presetBase || {});
    s.presetName = null; s.presetBase = null;
    toast(`「${name}」をオフにしました`);
  } else {
    pushUndo(`プリセット「${name}」をオン`);
    if (s.presetName) Object.assign(s, s.presetBase || {}); // 別のプリセットが適用中なら先に元へ戻す
    const patch = { ...STYLE_PRESETS[name] };
    if (patch.writingMode !== 'vertical' && s.writingMode === 'horizontal' && s.posX === 80) patch.posX = 50;
    const base = {};
    for (const k of Object.keys(patch)) base[k] = s[k];
    if (patch.fontFamily) base.customFontId = s.customFontId;
    Object.assign(s, patch);
    if (patch.fontFamily) s.customFontId = null;
    s.presetName = name; s.presetBase = base;
  }
  syncStylePanel();
  changed({ lines: false, style: true });
}

/** フォント選択肢：Mac（Pages）のフォント＋読み込んだ全フォント＋追加したフォントファイル */
function buildFontOptions(s) {
  const cur = s.customFontId ? null : primaryFamily(s.fontFamily);
  const listed = new Set();
  let html = '', missing = '';
  for (const g of MAC_FONT_GROUPS) {
    let opts = '';
    for (const [fam, label] of g.fonts) {
      listed.add(fam);
      const v = escapeHtml(fontCss(fam, g.fallback));
      if (isFontAvailable(fam) || fam === cur) opts += `<option value="${v}" data-fam="${escapeHtml(fam)}">${escapeHtml(label)}</option>`;
      else missing += `<option value="${v}" data-fam="${escapeHtml(fam)}" disabled>${escapeHtml(label)}（未ダウンロード）</option>`;
    }
    if (opts) html += `<optgroup label="${escapeHtml(g.label)}">${opts}</optgroup>`;
  }
  const others = savedLocalFamilies().filter(f => !listed.has(f));
  if (others.length) html += `<optgroup label="その他の Mac のフォント">${others.map(f => `<option value="${escapeHtml(fontCss(f))}" data-fam="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('')}</optgroup>`;
  if (cur && !listed.has(cur) && !others.includes(cur)) html += `<option value="${escapeHtml(s.fontFamily)}" data-fam="${escapeHtml(cur)}">${escapeHtml(cur)}</option>`;
  if (S.fonts.length) html += `<optgroup label="追加したフォント">${S.fonts.map(f => `<option value="custom:${f.id}">📁 ${escapeHtml(f.name)}</option>`).join('')}</optgroup>`;
  html += `<optgroup label="フォントを増やす">${window.queryLocalFonts ? '<option value="__all">＋ Mac のすべてのフォントを表示…</option>' : ''}<option value="__add">＋ フォントファイルを追加…</option></optgroup>`;
  if (missing) html += `<optgroup label="${IS_IOS ? 'この端末にないフォント' : '未ダウンロード（Font Book で入手できます）'}">${IS_IOS ? missing.replaceAll('（未ダウンロード）', '') : missing}</optgroup>`;
  return html;
}

function syncStylePanel() {
  const s = P().style;
  const fs = $('#fontSelect');
  fs.innerHTML = buildFontOptions(s);
  if (s.customFontId) fs.value = `custom:${s.customFontId}`;
  else {
    const fam = primaryFamily(s.fontFamily);
    const opt = [...fs.options].find(o => o.dataset.fam === fam);
    if (opt) opt.selected = true;
  }
  const curFam = s.customFontId ? null : primaryFamily(s.fontFamily);
  const note = $('#fontNote');
  note.hidden = !curFam || isFontAvailable(curFam);
  note.textContent = !curFam ? '' : IS_IOS
    ? `「${curFam}」はこの端末にありません（代わりのフォントで表示されます）。「＋ フォントファイルを追加…」でフォントファイルを読み込むと使えます。`
    : `「${curFam}」はこの Mac にまだありません。Font Book.app で検索して「ダウンロード」すると使えます（それまでは代わりのフォントで表示されます）。`;
  $('#sizeVal').textContent = `${s.fontSize}px`;
  $('#stylePanel [data-size="1"]').disabled = s.fontSize >= SIZE_STEPS[SIZE_STEPS.length - 1];
  $('#stylePanel [data-size="-1"]').disabled = s.fontSize <= SIZE_STEPS[0];
  $$('#stylePanel [data-preset]').forEach(b => b.classList.toggle('on', b.dataset.preset === s.presetName));
  $$('#stylePanel [data-k]').forEach(el => {
    const k = el.dataset.k;
    if (k === 'fontFamily') return;
    if (el.type === 'checkbox') el.checked = !!s[k]; else el.value = s[k];
  });
  $$('#stylePanel [data-v]').forEach(el => {
    const k = el.dataset.v, f = STYLE_FIELDS.find(x => x.key === k);
    el.textContent = f?.type === 'color' ? s[k] : `${+(+s[k]).toFixed(2)}${f?.unit || ''}`;
  });
  $$('#stylePanel [data-seg]').forEach(seg => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.val === String(s[seg.dataset.seg]))));
  $$('#stylePanel [data-i]').forEach(el => {
    const f = STYLE_FIELDS[+el.dataset.i];
    el.hidden = f.showIf ? !f.showIf(s) : false;
  });
  const dot = $('#posPad .dot');
  dot.style.left = `${s.posX}%`;
  dot.style.top = `${s.posY}%`;
  const vw = P().video?.width || 16, vh = P().video?.height || 9;
  $('#posPad').style.aspectRatio = `${vw}/${vh}`;
  $('#posPad').style.maxHeight = '180px';
  $('#posPad').style.width = vw < vh ? 'auto' : '100%';
  $('#posPad').style.height = vw < vh ? '180px' : '';
  $('#posPad').style.margin = vw < vh ? '0 auto' : '';
}

async function loadFonts() {
  const fonts = await db.getAll('fonts').catch(() => []);
  S.fonts = [];
  for (const f of fonts) {
    try {
      const face = new FontFace(f.family, f.data);
      await face.load();
      document.fonts.add(face);
      S.fonts.push(f);
    } catch (e) { console.warn('font load failed', f.name, e); }
  }
}

async function addFontFile(file) {
  const data = await file.arrayBuffer();
  const id = uid('f_');
  const rec = { id, name: file.name.replace(/\.[^.]+$/, ''), family: `UF_${id}`, data, mime: file.type || 'font/ttf', ext: file.name.split('.').pop().toLowerCase() };
  try {
    const face = new FontFace(rec.family, data);
    await face.load();
    document.fonts.add(face);
  } catch (e) { toast('フォントを読み込めませんでした: ' + e.message, true); return; }
  await db.put('fonts', rec);
  S.fonts.push(rec);
  pushUndo('フォントの変更');
  P().style.customFontId = id;
  syncStylePanel();
  changed({ lines: false, style: true });
  toast(`フォント「${rec.name}」を追加しました`);
}

async function fontCssFor(style) {
  if (!style.customFontId) return '';
  const f = S.fonts.find(x => x.id === style.customFontId);
  if (!f) return '';
  const b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(new Blob([f.data], { type: f.mime })); });
  return `@font-face{font-family:"${f.family}";src:url(${b64});}`;
}

// ============================================================
// 書き出し
// ============================================================
async function openExportDialog() {
  const p = P();
  if (!S.file) { toast('先に動画を読み込んでください', true); return; }
  if (!S.cues.length && !(await confirmDialog('記録済みの字幕がありません。このまま書き出しますか？', { ok: '書き出す' }))) return;
  const base = (p.name || 'lyrics').replace(/[\\/:*?"<>|]/g, '_');
  const canPick = !!window.showSaveFilePicker;
  const big = S.file.size > 700 * 1024 * 1024;
  const dur = video.duration || p.video?.duration || 0;
  const secs = sectionRanges(sectionsOf(p.lines), S.cues);
  const secRows = secs.map((x, i) => {
    const ok = x.start != null;
    const end = ok ? (isFinite(x.end) ? x.end : dur) : 0;
    return `<label class="ex-sec ${ok ? '' : 'off'}"><input type="checkbox" data-sec="${i}" ${ok ? 'checked' : 'disabled'}>
      <b>${escapeHtml(x.name)}</b><span class="muted small">${ok ? `${fmtTime(x.start, false)} 〜 ${fmtTime(end, false)}（${(end - x.start).toFixed(1)} 秒・${x.cues.length} 行）` : '未記録'}</span></label>`;
  }).join('');
  openModal(`
    <div class="modal-head">字幕を焼き込んだ MP4 を書き出し<button class="btn ghost sm" data-close id="exClose">✕</button></div>
    <div class="modal-body">
      <div class="small">出力: <b>${p.video.width}×${p.video.height}</b>（${aspectLabel(p.video.width, p.video.height)}・元動画と同じ解像度）／ H.264 + AAC ／ 字幕 ${S.cues.length} 行</div>
      ${secs.length ? `<div class="block"><span>書き出す範囲</span>
        <div class="inline" style="gap:14px;flex-wrap:wrap">
          <label class="inline"><input type="radio" name="exMode" value="all" checked> 動画全体</label>
          <label class="inline"><input type="radio" name="exMode" value="sections"> セクションごとに分けて書き出す</label>
        </div></div>
      <div id="exSecs" class="ex-secs" hidden>
        <div class="inline" style="gap:8px"><button class="btn sm" id="exSecAll">すべて選択</button><button class="btn sm" id="exSecNone">選択解除</button></div>
        ${secRows}
        <div class="inline" style="gap:10px;flex-wrap:wrap">
          <label class="inline">開始の余白 <input id="exPadIn" type="number" min="0" max="10" step="0.1" value="0.5" style="width:64px"> 秒</label>
          <label class="inline">終了の余白 <input id="exPadOut" type="number" min="0" max="10" step="0.1" value="0" style="width:64px"> 秒</label>
        </div>
        <label class="inline"><input type="checkbox" id="exOwnOnly" checked> そのセクションの歌詞だけを表示する（余白に前後のセクションの歌詞を出さない）</label>
        <div class="muted small">ファイル名は「${escapeHtml(base)}_セクション名.mp4」になります（同じ名前のセクションは _2, _3…）。区間は、そのセクションで記録した最初の歌詞の開始から最後の歌詞の終了までです。</div>
      </div>` : '<div class="muted small">歌詞に [Aメロ] のようなセクションを入れると、セクションごとに分けて書き出せます（左の「歌詞を編集」または行の「🏷 ここからセクション」）。</div>'}
      <label class="block" id="exNameRow"><span>ファイル名</span><input id="exName" value="${escapeHtml(base)}_字幕.mp4"></label>
      <label class="block"><span>画質</span><select id="exQuality"><option value="high">高画質（ファイル大）</option><option value="standard" selected>標準（元動画と同程度）</option><option value="light">軽量</option></select></label>
      ${canPick ? `<label class="inline"><input type="checkbox" id="exStream" ${big ? 'checked' : ''}> <span id="exStreamLabel">先に保存先を選んで直接書き込む（大きな動画向け・メモリ節約）</span></label>` : ''}
      <div id="exProgress" hidden>
        <div class="bar"><div id="exBar"></div></div>
        <div class="small" id="exMsg" style="margin-top:6px"></div>
      </div>
      <div class="export-log" id="exLog" hidden></div>
      <div id="exResult" hidden></div>
      <div class="muted small">音声は再エンコードせず元のデータをそのままコピーするため、音質の劣化や音ズレは発生しません。映像は元動画のフレーム時刻を保ったまま再エンコードします。</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close id="exCancel">閉じる</button>
      <button class="btn accent" id="exStart">書き出し開始</button>
    </div>`, { wide: false, lock: true });
  const modeSections = () => document.querySelector('input[name="exMode"]:checked')?.value === 'sections';
  const syncMode = () => {
    const sec = modeSections();
    if ($('#exSecs')) $('#exSecs').hidden = !sec;
    $('#exNameRow').hidden = sec;
    if ($('#exStreamLabel')) $('#exStreamLabel').textContent = sec && window.showDirectoryPicker ? '先に保存先のフォルダを選んで直接書き込む' : '先に保存先を選んで直接書き込む（大きな動画向け・メモリ節約）';
    if ($('#exStream')) $('#exStream').closest('label').hidden = sec && !window.showDirectoryPicker;
  };
  document.querySelectorAll('input[name="exMode"]').forEach(r => r.addEventListener('change', syncMode));
  const setAll = v => document.querySelectorAll('#exSecs input[data-sec]:not(:disabled)').forEach(c => { c.checked = v; });
  $('#exSecAll') && ($('#exSecAll').onclick = () => setAll(true));
  $('#exSecNone') && ($('#exSecNone').onclick = () => setAll(false));
  syncMode();
  $('#exStart').onclick = () => runExport(modeSections() ? buildSectionJobs(secs, base, dur) : null);
}

/** セクションごとの書き出し内容（選んだセクションだけ）。区間は余白を足して動画の範囲に収める */
function buildSectionJobs(secs, base, dur) {
  const padIn = clamp(Number($('#exPadIn').value) || 0, 0, 10), padOut = clamp(Number($('#exPadOut').value) || 0, 0, 10);
  const ownOnly = $('#exOwnOnly').checked;
  const picked = [...document.querySelectorAll('#exSecs input[data-sec]:checked')].map(c => secs[+c.dataset.sec]);
  const names = uniqueNames(picked.map(x => `${base}_${x.name.replace(/[\\/:*?"<>|]/g, '_')}.mp4`));
  return picked.map((x, i) => {
    const end = isFinite(x.end) ? x.end : dur;
    return {
      name: names[i], label: x.name,
      range: { start: Math.max(0, x.start - padIn), end: Math.min(dur || Infinity, end + padOut) },
      cues: (ownOnly ? x.cues : S.cues).map(c => ({ ...c, end: isFinite(c.end) ? c.end : Infinity })),
    };
  });
}

async function saveBlobAs(blob, fileName) {
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: 'MP4 動画', accept: { 'video/mp4': ['.mp4'] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      toast('保存しました');
    } catch (e) { if (e.name !== 'AbortError') downloadBlob(blob, fileName); }
  } else downloadBlob(blob, fileName);
}

/**
 * 書き出しを実行する。jobs が null なら動画全体を1本、配列ならセクションごとに順に書き出す
 * （1本失敗しても残りは続ける）。
 */
async function runExport(jobs) {
  const p = P();
  const single = !jobs;
  if (single) {
    const name = $('#exName').value.trim() || 'output.mp4';
    jobs = [{ name: name.toLowerCase().endsWith('.mp4') ? name : `${name}.mp4`, label: null, range: null, cues: S.cues.map(c => ({ ...c, end: isFinite(c.end) ? c.end : Infinity })) }];
  }
  if (!jobs.length) { toast('書き出すセクションを選んでください', true); return; }
  // 保存先（直接書き込み）：1本ならファイル、セクションごとならフォルダを先に選ぶ
  let dir = null, writable = null;
  if ($('#exStream')?.checked && !$('#exStream').closest('label').hidden) {
    try {
      if (single) {
        const h = await window.showSaveFilePicker({ suggestedName: jobs[0].name, types: [{ description: 'MP4 動画', accept: { 'video/mp4': ['.mp4'] } }] });
        writable = await h.createWritable();
      } else dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) { if (e.name === 'AbortError') return; toast('保存先を開けませんでした: ' + e.message, true); return; }
  }
  const ac = new AbortController();
  S.exporting = true;
  $('#exStart').disabled = true;
  $('#exProgress').hidden = false;
  $('#exLog').hidden = false;
  $('#exResult').hidden = true;
  $('#exClose').hidden = true;
  const cancel = $('#exCancel');
  cancel.textContent = '中止';
  cancel.removeAttribute('data-close');
  cancel.onclick = () => ac.abort();
  video.pause();
  const logEl = $('#exLog');
  logEl.textContent = '';
  const addLog = m => { logEl.textContent += m + '\n'; logEl.scrollTop = 1e9; };
  const phaseW = { prep: [0, 0.05], encode: [0.05, 0.98], finalize: [0.98, 1] };
  const fontFamily = fontFamilyFor(p.style), fontCss = await fontCssFor(p.style);
  const results = [];
  let aborted = false;
  for (let j = 0; j < jobs.length && !aborted; j++) {
    const job = jobs[j];
    const tag = single ? '' : `[${j + 1}/${jobs.length} ${job.label}] `;
    if (!single) addLog(`── ${job.label}（${fmtTime(job.range.start)} 〜 ${fmtTime(job.range.end)}）→ ${job.name}`);
    const t0 = performance.now();
    try {
      let w = writable;
      if (dir) w = await (await dir.getFileHandle(job.name, { create: true })).createWritable();
      const res = await exportVideo({
        file: S.file, cues: job.cues, range: job.range, style: p.style, fontFamily, fontCss,
        quality: $('#exQuality').value, writable: w, signal: ac.signal,
        onProgress: ev => {
          if (ev.phase === 'log') { addLog(ev.msg); return; }
          const [a, b] = phaseW[ev.phase] || [0, 1];
          const r = (j + a + (b - a) * (ev.ratio || 0)) / jobs.length;
          $('#exBar').style.width = `${(r * 100).toFixed(1)}%`;
          let m = `${(r * 100).toFixed(0)}%　${tag}${ev.msg || ''}`;
          if (ev.fps) m += `　${ev.fps.toFixed(0)} fps`;
          if (ev.eta != null) m += `　残り約 ${Math.ceil(ev.eta)} 秒`;
          $('#exMsg').textContent = m;
        },
      });
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      addLog(`完了: ${res.frames} フレーム / ${res.width}×${res.height} / ${res.durationSec.toFixed(2)} 秒 / ${res.codec} / 音声: ${res.audioMode === 'copy' ? '元データをコピー' : res.audioMode === 'encoded' ? 'AACに変換' : 'なし'} / ${sec} 秒`);
      results.push({ job, res });
    } catch (e) {
      console.error(e);
      if (e.name === 'AbortError') { aborted = true; break; }
      addLog(`✗ ${tag}失敗: ${e.message}`);
      addLog(String(e.stack || e));
      results.push({ job, error: e });
    }
  }
  const okList = results.filter(x => x.res);
  const failed = results.filter(x => x.error);
  window.__lastExport = okList.length ? { blob: okList[0].res.blob, name: okList[0].job.name, result: okList[0].res, all: okList.map(x => ({ name: x.job.name, blob: x.res.blob, result: x.res })) } : null;
  $('#exBar').style.width = aborted ? $('#exBar').style.width : '100%';
  $('#exMsg').textContent = aborted ? '中止しました' : single && failed.length ? `エラー: ${failed[0].error.message}` : failed.length ? `書き出し完了 ${okList.length} 本・失敗 ${failed.length} 本` : `✓ 書き出しが完了しました${single ? '' : `（${okList.length} 本）`}`;
  if (failed.length && single) toast('書き出しに失敗しました: ' + failed[0].error.message, true);
  else if (failed.length) toast(`${failed.length} 本の書き出しに失敗しました（ログを確認してください）`, true);
  const r = $('#exResult');
  if (okList.length) {
    r.hidden = false;
    const shareable = x => x.res.blob && navigator.canShare?.({ files: [new File([x.res.blob], x.job.name, { type: 'video/mp4' })] });
    if (single && okList[0].res.blob) {
      const { res } = okList[0];
      const url = URL.createObjectURL(res.blob);
      const canShare = shareable(okList[0]);
      r.innerHTML = `<div class="inline" style="gap:8px;flex-wrap:wrap">${canShare ? `<button class="btn accent" data-share="0">📱 写真に保存 / 共有</button>` : ''}<button class="btn ${canShare ? '' : 'accent'}" data-save="0">💾 ファイルに保存（${fmtBytes(res.blob.size)}）</button></div>
        ${canShare ? '<div class="muted small">「写真に保存 / 共有」→「ビデオを保存」で写真アプリに保存できます。</div>' : ''}
        <video src="${url}" controls playsinline style="margin-top:10px;max-width:100%;max-height:300px;background:#000;border-radius:8px"></video>`;
    } else if (single || dir) {
      r.innerHTML = `<div>選択した保存先に書き込みました（${okList.map(x => escapeHtml(x.job.name)).join('、')}）。</div>`;
    } else {
      const anyShare = okList.some(shareable);
      r.innerHTML = `<div class="inline" style="gap:8px;flex-wrap:wrap;margin-bottom:6px">${anyShare ? '<button class="btn accent" data-share="all">📱 すべて写真に保存 / 共有</button>' : ''}<button class="btn ${anyShare ? '' : 'accent'}" data-save="all">💾 すべて保存</button></div>
        <ul class="ex-results">${okList.map((x, i) => `<li><span>${escapeHtml(x.job.name)}<span class="muted small">　${x.res.durationSec.toFixed(1)} 秒・${fmtBytes(x.res.blob.size)}</span></span>
          <span class="inline" style="gap:6px">${shareable(x) ? `<button class="btn sm" data-share="${i}">📱 共有</button>` : ''}<button class="btn sm" data-save="${i}">💾 保存</button><button class="btn sm" data-preview="${i}">▶</button></span></li>`).join('')}</ul>
        <video id="exPreview" controls playsinline hidden style="margin-top:10px;max-width:100%;max-height:300px;background:#000;border-radius:8px"></video>`;
    }
    r.onclick = async e => {
      const b = e.target.closest('button');
      if (!b) return;
      const pick = v => (v === 'all' ? okList : [okList[+v]]);
      if (b.dataset.share != null) {
        const files = pick(b.dataset.share).map(x => new File([x.res.blob], x.job.name, { type: 'video/mp4' }));
        try { await navigator.share({ files, title: files.length === 1 ? files[0].name : `${files.length} 本の動画` }); }
        catch (err) { if (err.name !== 'AbortError') toast('共有できませんでした: ' + err.message, true); }
      } else if (b.dataset.save != null) {
        const list = pick(b.dataset.save);
        if (list.length > 1 && window.showDirectoryPicker) {
          try {
            const d = await window.showDirectoryPicker({ mode: 'readwrite' });
            for (const x of list) { const w = await (await d.getFileHandle(x.job.name, { create: true })).createWritable(); await w.write(x.res.blob); await w.close(); }
            toast(`${list.length} 本を保存しました`);
          } catch (err) { if (err.name !== 'AbortError') toast('保存できませんでした: ' + err.message, true); }
        } else if (list.length > 1) {
          for (const x of list) { downloadBlob(x.res.blob, x.job.name); await new Promise(res => setTimeout(res, 400)); }
        } else await saveBlobAs(list[0].res.blob, list[0].job.name);
      } else if (b.dataset.preview != null) {
        const v = $('#exPreview');
        if (v._url) URL.revokeObjectURL(v._url);
        v._url = URL.createObjectURL(okList[+b.dataset.preview].res.blob);
        v.src = v._url; v.hidden = false; v.play().catch(() => {});
      }
    };
  }
  S.exporting = false;
  $('#exStart').disabled = false;
  $('#exStart').textContent = 'もう一度書き出す';
  $('#exClose').hidden = false;
  cancel.textContent = '閉じる';
  cancel.onclick = closeModal;
}

function exportSrt() {
  if (!S.cues.length) { toast('記録済みの字幕がありません', true); return; }
  const dur = video.duration || P().video?.duration || 0;
  const txt = S.cues.map((c, i) => `${i + 1}\n${fmtSrt(c.start)} --> ${fmtSrt(isFinite(c.end) ? c.end : dur)}\n${c.text}\n`).join('\n');
  downloadBlob(new Blob([txt], { type: 'text/plain' }), `${P().name || 'lyrics'}.srt`);
}

function exportAss() {
  if (!S.cues.length) { toast('記録済みの字幕がありません', true); return; }
  const p = P(), s = p.style, W = p.video?.width || 1920, H = p.video?.height || 1080, k = Math.min(W, H) / 1080;
  const dur = video.duration || p.video?.duration || 0;
  const assColor = (hex, a = 1) => { const h = hex.replace('#', ''); return `&H${Math.round((1 - a) * 255).toString(16).padStart(2, '0')}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase(); };
  const t = x => { const cs = Math.round(x * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`; };
  const font = (s.customFontId ? S.fonts.find(f => f.id === s.customFontId)?.name : s.fontFamily.split(',')[0].replace(/"/g, '').trim()) || 'sans-serif';
  const vertical = s.writingMode === 'vertical';
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Lyric,${vertical ? '@' : ''}${font},${Math.round(s.fontSize * k)},${assColor(s.color)},${assColor(s.color)},${assColor(s.strokeColor)},${assColor(s.shadowColor, s.shadowOpacity)},${s.fontWeight >= 600 ? -1 : 0},0,0,0,100,100,0,${vertical ? 270 : 0},${s.bgMode === 'none' ? 1 : 3},${s.strokeWidth * k},${s.shadowEnabled ? Math.max(1, Math.round(Math.hypot(s.shadowX, s.shadowY) * k)) : 0},5,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const fade = s.animation !== 'none' ? `{\\fad(${Math.round(s.animIn * 1000)},${Math.round(s.animOut * 1000)})}` : '';
  const body = S.cues.map(c => `Dialogue: 0,${t(c.start)},${t(isFinite(c.end) ? c.end : dur)},Lyric,,0,0,0,,{\\pos(${Math.round(W * s.posX / 100)},${Math.round(H * s.posY / 100)})}${fade}${c.text}`).join('\n');
  downloadBlob(new Blob([head + body + '\n'], { type: 'text/plain' }), `${p.name || 'lyrics'}.ass`);
  toast('ASS を書き出しました（縦書きは表示ソフトにより再現度が異なります）');
}

// ============================================================
// プロジェクト管理
// ============================================================
async function openProject(id) {
  if (P() && S.dirty) await saveProject(false);
  const p = await db.get('projects', id);
  if (!p) { toast('プロジェクトが見つかりません', true); return; }
  activateProject(normalizeProject(p));
  await restoreVideo();
}

function activateProject(p) {
  if (S.recordMode) setRecordMode(false);
  S.project = p;
  S.undo = []; S.redo = [];
  S.selectedId = null;
  S.dirty = false;
  S.overlayKey = null;
  $('#projectName').value = p.name;
  $('#recordKey').value = p.editor.recordKey;
  $('#recordOffset').value = p.editor.recordOffset;
  $('#seekStep').value = p.editor.seekStep;
  $('#tlZoom').value = p.editor.zoom;
  timeline.setZoom(p.editor.zoom);
  applyCompact();
  syncStylePanel();
  recomputeCues();
  renderLines();
  renderVideoInfo();
  updateSaveState();
  db.setMeta('lastProjectId', p.id);
}

async function createNewProject() {
  if (P() && S.dirty) await saveProject(false);
  const p = newProject();
  // デザインは既定値（縁取りなし）から始め、記録キーなどの操作設定だけ引き継ぐ
  if (P()) { p.editor.recordKey = P().editor.recordKey; p.editor.recordOffset = P().editor.recordOffset; }
  activateProject(p);
  await saveProject(false);
  await restoreVideo();
  toast('新しいプロジェクトを作成しました');
}

async function openProjectsDialog() {
  await saveProject(false);
  const list = (await db.getAll('projects')).sort((a, b) => b.updatedAt - a.updatedAt);
  openModal(`
    <div class="modal-head">プロジェクトを開く<button class="btn ghost sm" data-close>✕</button></div>
    <div class="modal-body"><ul class="proj-list">${list.map(p => {
      const rec = (p.lines || []).filter(l => p.timings?.[l.id]?.start != null).length;
      return `<li class="${p.id === P().id ? 'current' : ''}" data-id="${p.id}"><div class="grow"><b>${escapeHtml(p.name || '無題')}</b>
        <div class="muted small">${p.video ? '🎞 ' + escapeHtml(p.video.name) + '・' : ''}${rec}/${(p.lines || []).length}行記録・${new Date(p.updatedAt).toLocaleString('ja-JP')}</div></div>
        <button class="btn sm primary" data-a="open">開く</button><button class="btn sm" data-a="dup">複製</button><button class="btn sm danger" data-a="del">削除</button></li>`;
    }).join('')}</ul></div>
    <div class="modal-foot"><button class="btn" data-a="new">＋ 新規プロジェクト</button><button class="btn" data-close>閉じる</button></div>`);
  $('#modalCard').onclick = async e => {
    const a = e.target.dataset.a;
    if (!a) return;
    if (a === 'new') { closeModal(); createNewProject(); return; }
    const id = e.target.closest('li')?.dataset.id;
    if (a === 'open') { closeModal(); openProject(id); }
    if (a === 'dup') {
      const src = await db.get('projects', id);
      const copy = { ...src, id: uid('p_'), name: `${src.name}（コピー）`, createdAt: Date.now(), updatedAt: Date.now() };
      await db.put('projects', copy);
      const h = await db.get('handles', id).catch(() => null);
      if (h) await db.put('handles', { id: copy.id, handle: h.handle });
      copy.editor = { ...copy.editor, storeVideo: false };
      await db.put('projects', copy);
      openProjectsDialog();
    }
    if (a === 'del') {
      if (id === P().id) { toast('開いているプロジェクトは削除できません', true); return; }
      const yes = await confirmDialog('このプロジェクトを削除しますか？（歌詞ライブラリは残ります）', { ok: '削除する', danger: true });
      if (!yes) { openProjectsDialog(); return; }
      await db.delete('projects', id); await db.delete('videos', id).catch(() => {}); await db.delete('handles', id).catch(() => {});
      openProjectsDialog();
    }
  };
}

function exportProjectJson() {
  const p = deepClone(P());
  p.editor.currentTime = video.currentTime || 0;
  const data = { app: 'lyrics-subtitle-editor', version: 1, exportedAt: new Date().toISOString(), project: p, lyricSet: S.library.find(s => s.id === p.lyricSetId) || null };
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${p.name || 'project'}.lyricsproj.json`);
}

async function importProjectJson(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.project) throw new Error('プロジェクトファイルではありません');
    const p = normalizeProject(data.project);
    p.id = uid('p_');
    p.editor.storeVideo = false;
    if (data.lyricSet && !S.library.some(s => s.id === data.lyricSet.id)) await saveLyricSet(data.lyricSet);
    if (S.dirty) await saveProject(false);
    activateProject(p);
    await saveProject(false);
    await restoreVideo();
    toast('プロジェクトを読み込みました。動画ファイルを選択してください');
  } catch (e) { toast('読み込みに失敗しました: ' + e.message, true); }
}

// ============================================================
// モーダル・トースト・ヘルプ
// ============================================================
function openModal(html, { wide = false, lock = false } = {}) {
  const m = $('#modal'), card = $('#modalCard');
  card.className = 'modal-card' + (wide ? ' wide' : '');
  card.innerHTML = html;
  card.onclick = null;
  m.hidden = false;
  m.dataset.lock = lock ? '1' : '';
}
/**
 * アプリ内の確認ダイアログ。window.confirm は一部の環境（アプリ内ブラウザなど）で表示されずに
 * 即 false になり、操作が何も起きなくなるため使わない。
 */
function confirmDialog(message, { ok = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    openModal(`<div class="modal-head">確認</div>
      <div class="modal-body"><div style="white-space:pre-wrap;line-height:1.6">${escapeHtml(message)}</div></div>
      <div class="modal-foot"><button class="btn" id="dlgCancel">キャンセル</button><button class="btn ${danger ? 'danger-fill' : 'primary'}" id="dlgOk">${escapeHtml(ok)}</button></div>`, { lock: true });
    const done = v => { closeModal(); resolve(v); };
    $('#dlgOk').onclick = () => done(true);
    $('#dlgCancel').onclick = () => done(false);
    setTimeout(() => $('#dlgOk')?.focus(), 30);
  });
}

/** アプリ内の入力ダイアログ（window.prompt の代わり）。キャンセル時は null */
function promptDialog(message, def = '', { ok = 'OK', inputmode = 'text' } = {}) {
  return new Promise(resolve => {
    openModal(`<div class="modal-head">${escapeHtml(message)}</div>
      <div class="modal-body"><input id="dlgInput" inputmode="${inputmode}" value="${escapeHtml(def)}"></div>
      <div class="modal-foot"><button class="btn" id="dlgCancel">キャンセル</button><button class="btn primary" id="dlgOk">${escapeHtml(ok)}</button></div>`, { lock: true });
    const inp = $('#dlgInput');
    const done = v => { closeModal(); resolve(v); };
    $('#dlgOk').onclick = () => done(inp.value);
    $('#dlgCancel').onclick = () => done(null);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) done(inp.value); });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}

function closeModal() { $('#modal').hidden = true; $('#modalCard').innerHTML = ''; }
$('#modal').addEventListener('click', e => {
  if (e.target.closest('[data-close]') && !S.exporting) closeModal();
  else if (e.target === $('#modal') && !$('#modal').dataset.lock) closeModal();
});

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 4500 : 2200);
}

function showHelp() {
  const k = keyLabel(P().editor.recordKey);
  openModal(`<div class="modal-head">キーボードショートカット<button class="btn ghost sm" data-close>✕</button></div>
    <div class="modal-body"><table class="kbd-table">
      <tr><td><kbd>R</kbd></td><td>記録モードの開始 / 終了（<kbd>Esc</kbd> でも終了）</td></tr>
      <tr><td><kbd>${k}</kbd>${k === 'Shift' ? '（左右どちらでも）' : ''}</td><td>記録モード中：現在の再生時間を記録して次の歌詞へ進む</td></tr>
      <tr><td><kbd>Space</kbd></td><td>再生 / 一時停止</td></tr>
      <tr><td><kbd>←</kbd> <kbd>→</kbd></td><td>${P().editor.seekStep} 秒戻る / 進む（右パネルで変更可）</td></tr>
      <tr><td><kbd>,</kbd> <kbd>.</kbd></td><td>1フレーム（1/30秒）戻る / 進む</td></tr>
      <tr><td><kbd>E</kbd></td><td>表示中の字幕をこの時刻で消す（間奏など）</td></tr>
      <tr><td><kbd>⌘/Ctrl</kbd>+<kbd>Z</kbd></td><td>直前の操作を取り消す（記録の取り消し）</td></tr>
      <tr><td><kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd></td><td>やり直し</td></tr>
      <tr><td><kbd>⌘/Ctrl</kbd>+<kbd>S</kbd></td><td>保存（変更は自動保存もされます）</td></tr>
      <tr><td>タイムライン</td><td>ブロックをドラッグで移動、端で開始/終了を調整（再生位置にスナップ、<kbd>Alt</kbd>で解除）。<kbd>⌘/Ctrl</kbd>+ホイールでズーム</td></tr>
    </table>
    <p class="muted small">文字入力欄にカーソルがある間はショートカットは無効です。</p></div>`);
}

// ============================================================
// 初期化
// ============================================================
let seekDragging = false;
const SEEK_STEPS = 10000; // シークバーの分解能（0〜10000 = 動画の 0%〜100%）

/** シークバーのつまみ位置 = 再生時間 ÷ 動画の長さ（長さ不明・0秒のときは左端） */
function updateSeekBar(t = video.currentTime || 0) {
  const d = video.duration;
  $('#seek').value = d > 0 && isFinite(d) ? Math.round(clamp(t / d, 0, 1) * SEEK_STEPS) : 0;
}
const timeline = new Timeline({
  el: $('#timeline'), inner: $('#tlInner'), ruler: $('#tlRuler'), wave: $('#tlWave'), cuesEl: $('#tlCues'), playhead: $('#tlPlayhead'),
  onSeek: t => seekTo(t),
  onSelect: (id, seek) => selectLine(id, { seek }),
  getPlayhead: () => video.currentTime,
  onDragStart: () => pushUndo('タイムラインでの調整'),
  onCueChange: (id, { start, end }) => {
    const p = P();
    const t = p.timings[id];
    if (!t) return;
    t.start = +start.toFixed(3);
    t.end = end == null ? null : +end.toFixed(3);
    recomputeCues();
    renderOverlay(true);
  },
  onDragEnd: () => changed(),
  onZoom: pps => { P().editor.zoom = Math.round(pps); $('#tlZoom').value = P().editor.zoom; },
});

function applyCompact() {
  const on = !!P().editor.compactTimeline;
  $('#app').classList.toggle('compact', on);
  $('#btnCompact').textContent = on ? '⤡ 通常表示' : '⤢ プレビュー拡大';
  requestAnimationFrame(() => { fitStage(); timeline.layout(); });
}

/** 左の「歌詞・タイミング」を縮小表示（PC：細い帯 / スマホ：見出しだけ） */
function setLeftCollapsed(on) {
  $('#app').classList.toggle('left-collapsed', on);
  $('#btnCollapseLeft').textContent = on ? '»' : '«';
  $('#btnCollapseLeft').title = on ? '歌詞・タイミングを展開' : '歌詞・タイミングを縮小';
  try { localStorage.setItem('lse.leftCollapsed', on ? '1' : '0'); } catch { /* 無視 */ }
  requestAnimationFrame(() => { fitStage(); timeline.layout(); });
}

function bindUI() {
  $('#btnOpenVideo').onclick = openVideoDialog;
  $('#btnOpenVideo2').onclick = openVideoDialog;
  $('#fileVideo').onchange = e => { const f = e.target.files[0]; if (f) loadVideoFile(f); e.target.value = ''; };
  $('#fileJson').onchange = e => { const f = e.target.files[0]; if (f) importProjectJson(f); e.target.value = ''; };
  $('#fileFont').onchange = e => { const f = e.target.files[0]; if (f) addFontFile(f); e.target.value = ''; };
  $('#btnPlay').onclick = togglePlay;
  $('#btnPlay2').onclick = togglePlay;
  const toStart = () => { if (!S.file) return; seekTo(0); timeline.scrollToTime(0); };
  $('#btnToStart').onclick = toStart;
  $('#btnToStart2').onclick = toStart;
  $('#btnRecord').onclick = toggleRecordMode;
  // 記録ボタン（iPhone 用）。指が触れた瞬間（pointerdown）の時刻で記録する
  $('#btnTap').addEventListener('pointerdown', e => {
    if (!S.recordMode) return;
    e.preventDefault();
    recordNow(e.timeStamp);
  });
  $('#btnUndo').onclick = undo;
  $('#btnCueEdit').onclick = openCueTextDialog;
  $('#btnCueSplit').onclick = splitCueAtPlayhead;
  $('#btnCueDelete').onclick = deleteSelectedCue;
  $('#btnHideLyric').addEventListener('pointerdown', e => { e.preventDefault(); endCurrentCue(e.timeStamp); });
  $('#btnCollapseLeft').onclick = () => setLeftCollapsed(!$('#app').classList.contains('left-collapsed'));
  $('#leftPanel').addEventListener('click', e => { if ($('#app').classList.contains('left-collapsed') && !e.target.closest('#btnCollapseLeft')) setLeftCollapsed(false); });
  try { setLeftCollapsed(localStorage.getItem('lse.leftCollapsed') === '1'); } catch { /* 無視 */ }
  $('#btnMute').onclick = () => { video.muted = !video.muted; $('#btnMute').textContent = video.muted ? '🔇' : '🔊'; };
  $('#rate').onchange = e => { video.playbackRate = Number(e.target.value); };
  const seek = $('#seek');
  seek.max = SEEK_STEPS;
  seek.step = 1;
  // ドラッグ中だけ再生位置への追従を止める。指やマウスをバーの外で離した場合・iPhone でタッチが
  // キャンセルされた場合（pointercancel）も必ず解除する（解除漏れでつまみが止まったままになっていた）
  const endDrag = () => { if (seekDragging) { seekDragging = false; updateSeekBar(); } };
  seek.addEventListener('pointerdown', () => { seekDragging = true; });
  ['pointerup', 'pointercancel'].forEach(ev => window.addEventListener(ev, endDrag));
  seek.addEventListener('change', endDrag);
  seek.addEventListener('blur', endDrag);
  seek.addEventListener('input', () => {
    const d = video.duration;
    if (d > 0 && isFinite(d)) seekTo(seek.value / SEEK_STEPS * d);
  });
  $('#btnExport').onclick = openExportDialog;
  $('#btnExport2').onclick = openExportDialog;
  $('#btnHelp').onclick = showHelp;
  $('#btnEditLines').onclick = openLyricsEditor;
  $('#btnCursorTop').onclick = () => { const p = P(); p.editor.cursor = firstUnrecorded(p.lines, p.timings); changed(); scrollLineIntoView(p.lines[p.editor.cursor]?.id); };
  $('#btnClearTimings').onclick = async () => {
    const p = P();
    if (!Object.keys(p.timings).length) { toast('消去するタイミングはありません'); return; }
    if (!(await confirmDialog('すべての歌詞のタイミング（表示開始・終了時刻）を消去しますか？\n歌詞の文字・デザイン・動画はそのまま残ります。\n（↶ 取り消しで元に戻せます）', { ok: '全消去する', danger: true }))) return;
    pushUndo('タイミング全消去');
    p.timings = {};
    p.editor.cursor = 0;
    S.selectedId = null;
    timeline.setSelected(null);
    changed();
    toast('すべてのタイミングを消去しました（歌詞はすべて未記録になりました）');
  };
  $('#btnShiftAll').onclick = async () => {
    const v = await promptDialog('すべてのタイミングをずらす秒数（例: 0.2 で遅く、-0.2 で早く）', '0.1', { ok: 'ずらす', inputmode: 'decimal' });
    const d = Number(v);
    if (v == null || !isFinite(d) || d === 0) return;
    pushUndo('一括ずらし');
    const p = P();
    for (const t of Object.values(p.timings)) {
      if (t.start != null) t.start = +Math.max(0, t.start + d).toFixed(3);
      if (t.end != null) t.end = +Math.max(0, t.end + d).toFixed(3);
    }
    changed();
  };
  $('#projectName').addEventListener('change', e => { P().name = e.target.value.trim() || '無題'; S.dirty = true; autosave(); });
  $('#projectName').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
  // プロジェクトメニュー
  const menu = $('#projectMenu');
  $('#btnProjectMenu').onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', e => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    menu.hidden = true;
    if (a === 'newProject') createNewProject();
    if (a === 'openProjects') openProjectsDialog();
    if (a === 'save') saveProject(true);
    if (a === 'exportJson') exportProjectJson();
    if (a === 'importJson') $('#fileJson').click();
    if (a === 'exportSrt') exportSrt();
    if (a === 'exportAss') exportAss();
  });
  // 記録設定
  $('#recordKey').onchange = e => { P().editor.recordKey = e.target.value; updateRecordBar(); S.dirty = true; autosave(); };
  $('#recordOffset').onchange = e => { P().editor.recordOffset = clamp(Number(e.target.value) || 0, 0, 1); S.dirty = true; autosave(); };
  $('#seekStep').onchange = e => { P().editor.seekStep = clamp(Number(e.target.value) || 2, 0.1, 30); S.dirty = true; autosave(); };
  $('#tlZoom').oninput = e => { const t = video.currentTime; timeline.setZoom(Number(e.target.value)); P().editor.zoom = Number(e.target.value); timeline.scrollToTime(t); };
  $('#tlFollow').onchange = e => { timeline.follow = e.target.checked; };
  $('#btnCompact').onclick = () => { P().editor.compactTimeline = !P().editor.compactTimeline; applyCompact(); S.dirty = true; autosave(); };
  // ドラッグ＆ドロップ
  const wrap = $('#stageWrap');
  wrap.addEventListener('dragover', e => { e.preventDefault(); wrap.classList.add('dragover'); });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('dragover'));
  wrap.addEventListener('drop', async e => {
    e.preventDefault();
    wrap.classList.remove('dragover');
    const item = [...e.dataTransfer.items].find(i => i.kind === 'file');
    if (!item) return;
    let handle = null;
    try { handle = await item.getAsFileSystemHandle?.(); } catch { /* 非対応 */ }
    const f = handle?.kind === 'file' ? await handle.getFile() : item.getAsFile();
    if (f) loadVideoFile(f, handle?.kind === 'file' ? handle : null);
  });
  // 動画クリックで再生/一時停止
  $('#stage').addEventListener('click', togglePlay);
  new ResizeObserver(fitStage).observe(wrap);
  video.addEventListener('durationchange', () => { if (isFinite(video.duration)) { recomputeCues(); timeline.setDuration(video.duration); updateSeekBar(); } });
  video.addEventListener('seeked', () => renderOverlay(true));
  // 描画ループ（requestAnimationFrame）が止まる状況でも、シークバーと時刻表示が動画の再生位置に一致するようにする
  ['timeupdate', 'seeked', 'loadedmetadata'].forEach(ev => video.addEventListener(ev, () => {
    if (!seekDragging) updateSeekBar();
    $('#timeCur').textContent = fmtTime(video.currentTime || 0);
  }));
  window.addEventListener('beforeunload', e => { if (S.dirty) { saveProject(false); e.preventDefault(); } });
  setupLineList();
  setupLibrary();
  buildStylePanel();
  const setStyleOpen = open => {
    $('#stylePanel').hidden = !open;
    $('#styleTitle').classList.toggle('closed', !open);
    try { localStorage.setItem('lse.styleOpen', open ? '1' : '0'); } catch { /* 無視 */ }
  };
  let styleOpen = true;
  try { styleOpen = localStorage.getItem('lse.styleOpen') !== '0'; } catch { /* 無視 */ }
  setStyleOpen(styleOpen);
  $('#styleTitle').onclick = () => setStyleOpen($('#stylePanel').hidden);
}

/** iPhone の Safari で開いている時だけ、ホーム画面への追加を一度案内する */
function showInstallHint() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let seen = false;
  try { seen = localStorage.getItem('lse.installHint') === '1'; } catch { /* 無視 */ }
  if (!IS_IOS || standalone || seen) return;
  const el = document.createElement('div');
  el.className = 'install-hint';
  el.innerHTML = `<div><b>ホーム画面に追加がおすすめです</b><br>Safari の共有ボタン <span aria-hidden="true">⎋</span>（□に↑）→「ホーム画面に追加」。アプリのように全画面で使え、保存した歌詞やプロジェクトが消えにくくなります。</div><button class="btn sm">閉じる</button>`;
  el.querySelector('button').onclick = () => { el.remove(); try { localStorage.setItem('lse.installHint', '1'); } catch { /* 無視 */ } };
  document.body.appendChild(el);
}

async function init() {
  bindUI();
  await Promise.all([loadLibrary(), loadFonts()]);
  const lastId = await db.getMeta('lastProjectId');
  const last = lastId && await db.get('projects', lastId);
  activateProject(last ? normalizeProject(last) : newProject());
  if (!last) await saveProject(false);
  await restoreVideo();
  await applyPendingLyricSet();
  requestAnimationFrame(loop);
  showInstallHint();
  // 開発・テスト用: ?video=URL で動画を読み込む
  const qv = new URLSearchParams(location.search).get('video');
  if (qv) {
    const res = await fetch(qv);
    const blob = await res.blob();
    await loadVideoFile(new File([blob], qv.split('/').pop(), { type: blob.type || 'video/mp4', lastModified: Date.now() }));
  }
}

init().catch(e => { console.error(e); toast('初期化に失敗しました: ' + e.message, true); });

// ホーム画面アプリ（PWA）・オフライン起動用。http://localhost / https でのみ有効
if ('serviceWorker' in navigator && isSecureContext && !/[?&]nosw\b/.test(location.search)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('service worker', e)));
}

export { S, recordNow, undo, redo, saveProject, openProject, loadVideoFile, useLyricSet };
