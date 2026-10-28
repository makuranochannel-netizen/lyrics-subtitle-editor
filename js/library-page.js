// 歌詞ライブラリ（別ページ）
// エディタとは IndexedDB を共有し、「このプロジェクトで使う」は BroadcastChannel でエディタに伝える。
// エディタが開いていない場合（iPhone で同じ画面内で開いた場合など）は、読み込み待ちとして保存してからエディタへ戻る。
import { db } from './db.js';
import { uid, deepClone, escapeHtml, mergeLines, splitLyrics } from './util.js';
import { LIB_CHANNEL, PENDING_KEY } from './library-link.js';

const $ = s => document.querySelector(s);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel(LIB_CHANNEL) : null;
let library = [];
let inUseId = null;

async function load() {
  library = (await db.getAll('lyrics')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || b.updatedAt - a.updatedAt);
  const lastId = await db.getMeta('lastProjectId');
  inUseId = lastId ? (await db.get('projects', lastId))?.lyricSetId ?? null : null;
}

function render() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const items = library.filter(s => !q || s.title.toLowerCase().includes(q) || (s.artist || '').toLowerCase().includes(q) || s.lines.some(l => l.text.toLowerCase().includes(q)));
  $('#libCount').textContent = `${library.length} 曲`;
  $('#libraryList').innerHTML = items.length ? items.map(s => `
    <li class="lib-item ${s.id === inUseId ? 'in-use' : ''}" data-id="${s.id}">
      <div class="lib-item-title">${escapeHtml(s.title || '（無題）')}</div>
      <div class="lib-item-sub">${s.artist ? escapeHtml(s.artist) + '・' : ''}${s.lines.length}行・更新 ${new Date(s.updatedAt).toLocaleDateString('ja-JP')}${s.id === inUseId ? '・<b style="color:var(--primary)">使用中</b>' : ''}</div>
      <div class="lib-item-preview">${escapeHtml(s.lines.slice(0, 3).map(l => l.text).join(' / '))}</div>
      <div class="lib-item-btns">
        <button class="btn primary" data-a="use">このプロジェクトで使う</button>
        <button class="btn" data-a="edit">編集</button>
        <button class="btn" data-a="dup">複製</button>
        <button class="btn" data-a="up" title="上へ">↑</button><button class="btn" data-a="down" title="下へ">↓</button>
        <button class="btn danger" data-a="del">削除</button>
      </div>
    </li>`).join('') : `<li class="empty-hint">${q ? '一致する歌詞はありません' : '保存された歌詞はありません。<br>「＋ 新しい歌詞」から作成してください。'}</li>`;
}

async function save(set) {
  set.updatedAt = Date.now();
  await db.put('lyrics', deepClone(set));
  channel?.postMessage({ type: 'libraryChanged' });
  await load();
  render();
}

async function renumber() {
  for (let i = 0; i < library.length; i++) {
    if (library[i].order !== i) { library[i].order = i; await db.put('lyrics', deepClone(library[i])); }
  }
  channel?.postMessage({ type: 'libraryChanged' });
  render();
}

/** エディタに「この歌詞を使う」と伝える。応答が無ければ読み込み待ちとして保存してエディタへ移動 */
async function useInEditor(set) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify({ id: set.id, at: Date.now() })); } catch { /* 無視 */ }
  let acked = false;
  if (channel) {
    const onMsg = e => { if (e.data?.type === 'ack' && e.data.id === set.id) acked = true; };
    channel.addEventListener('message', onMsg);
    channel.postMessage({ type: 'useLyricSet', id: set.id });
    await new Promise(r => setTimeout(r, 500));
    channel.removeEventListener('message', onMsg);
  }
  if (acked) {
    inUseId = set.id;
    render();
    toast(`「${set.title}」をエディタに読み込みました`);
    if (window.opener && !window.opener.closed) window.opener.focus();
  } else {
    location.href = 'index.html';
  }
}

function openEditor(set) {
  const card = $('#modalCard');
  card.className = 'modal-card';
  card.innerHTML = `
    <div class="modal-head">${set ? '歌詞を編集' : '新しい歌詞'}<button class="btn ghost sm" data-close>✕</button></div>
    <div class="modal-body">
      <label class="block"><span>楽曲名</span><input id="edTitle" value="${escapeHtml(set?.title || '')}" placeholder="例：朝焼けのカーテン"></label>
      <label class="block"><span>アーティスト（任意）</span><input id="edArtist" value="${escapeHtml(set?.artist || '')}"></label>
      <label class="block"><span>歌詞（1行＝1字幕。空行は無視されます）</span>
        <textarea id="edLines" placeholder="もう朝焼けがカーテンを染める&#10;君のいない部屋で目を覚ます">${escapeHtml((set?.lines || []).map(l => l.text).join('\n'))}</textarea></label>
      <div class="muted small" id="edCount"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>キャンセル</button>
      <button class="btn" id="edSave">保存</button>
      <button class="btn primary" id="edSaveUse">保存してこのプロジェクトで使う</button>
    </div>`;
  $('#modal').hidden = false;
  const ta = $('#edLines');
  const count = () => { $('#edCount').textContent = `${splitLyrics(ta.value).length} 行`; };
  ta.addEventListener('input', count);
  count();
  setTimeout(() => (set ? ta : $('#edTitle')).focus(), 50);
  const doSave = async use => {
    const texts = splitLyrics(ta.value);
    if (!texts.length) { toast('歌詞を1行以上入力してください', true); return; }
    const s = set ? deepClone(set) : { id: uid('s_'), createdAt: Date.now(), order: -1, lines: [] };
    s.title = $('#edTitle').value.trim() || '無題の歌詞';
    s.artist = $('#edArtist').value.trim();
    s.lines = mergeLines(s.lines, texts);
    await save(s);
    if (!set) await renumber();
    closeModal();
    toast('歌詞を保存しました');
    if (use) useInEditor(library.find(x => x.id === s.id));
  };
  $('#edSave').onclick = () => doSave(false);
  $('#edSaveUse').onclick = () => doSave(true);
}

function closeModal() { $('#modal').hidden = true; $('#modalCard').innerHTML = ''; }

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), err ? 4500 : 2200);
}

$('#modal').addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === $('#modal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
$('#libSearch').addEventListener('input', render);
$('#btnNewLyrics').onclick = () => openEditor(null);
// 別タブで開いた場合は「エディタ」ボタンで元のタブに戻る
$('#btnBack').addEventListener('click', e => {
  if (window.opener && !window.opener.closed) { e.preventDefault(); window.opener.focus(); }
});
$('#libraryList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-a]');
  const li = e.target.closest('.lib-item');
  if (!btn || !li) return;
  const set = library.find(s => s.id === li.dataset.id);
  const idx = library.indexOf(set);
  const a = btn.dataset.a;
  if (a === 'use') useInEditor(set);
  if (a === 'edit') openEditor(set);
  if (a === 'dup') {
    const copy = { ...deepClone(set), id: uid('s_'), title: `${set.title}（コピー）`, createdAt: Date.now(), order: (set.order ?? 0) + 0.5 };
    copy.lines = copy.lines.map(l => ({ id: uid('l_'), text: l.text }));
    await save(copy);
    await renumber();
    toast('歌詞を複製しました');
  }
  if (a === 'up' || a === 'down') {
    const j = a === 'up' ? idx - 1 : idx + 1;
    if (j < 0 || j >= library.length) return;
    [library[idx], library[j]] = [library[j], library[idx]];
    await renumber();
  }
  if (a === 'del') {
    if (!confirm(`歌詞「${set.title}」を削除しますか？\n（この歌詞を使っているプロジェクトの歌詞・タイミングは残ります）`)) return;
    await db.delete('lyrics', set.id);
    channel?.postMessage({ type: 'libraryChanged' });
    await load();
    render();
    toast('削除しました');
  }
});
channel?.addEventListener('message', async e => { if (e.data?.type === 'projectChanged') { await load(); render(); } });

await load();
render();
if (new URLSearchParams(location.search).has('new')) openEditor(null);
