// プロジェクト開始フロー（スタート画面 → 歌詞選択 → 動画読み込み → 字幕編集）
//
// ・編集画面（#app）の上に全画面のレイヤー（#flow）を重ねて表示する。編集画面は裏でそのまま残すので、
//   戻ってきたときにレイアウトや再生位置が崩れない。
// ・画面は URL のハッシュ（#/start, #/lyrics, #/lyrics-new, #/video, #/edit）で管理し、
//   ブラウザや iPhone の「戻る」でも前の画面に戻れる。
// ・新しいプロジェクトは「歌詞を決めた時点」で作る。途中で戻ってやめても空のプロジェクトは残らない。
// ・歌詞ライブラリの原本は読むだけで、プロジェクトには歌詞のコピーを入れる（タイミングはプロジェクトごと）。
import { db } from './db.js';
import { uid, deepClone, escapeHtml, fmtTime, fmtBytes, parseLyricsText } from './util.js';

const SCREENS = ['start', 'lyrics', 'lyrics-new', 'video', 'edit'];
const STEPS = ['プロジェクト開始', '歌詞選択', '動画読み込み', '字幕編集'];
const STEP_OF = { start: 0, lyrics: 1, 'lyrics-new': 1, video: 2, edit: 3 };
const DRAFT_KEY = 'lse.newLyricsDraft';

/**
 * @param api app.js の機能（S, P, toast, confirmDialog, loadLibrary, saveLyricSet, saveProject, activateProject,
 *            newProject, restoreVideo, loadVideoFile, openProject, openProjectsDialog, setRecordMode, aspectLabel, video）
 */
export function setupFlow(api) {
  const { S, P } = api;
  const $ = sel => document.querySelector(sel);
  const root = $('#flow');
  const F = {
    screen: 'edit',
    targetId: null,     // このフローで準備中のプロジェクト（歌詞を決めた時点で作る）
    selectedSetId: null, // 歌詞選択画面で選んでいる歌詞
    showDetail: false,  // スマホ：選んだ歌詞の内容を表示中
    query: '',
    draft: loadDraft(), // 新しい歌詞の入力途中の内容（戻っても消えない）
    videoError: null,
    videoBusy: false,
  };

  root.innerHTML = `
    <div class="flow-wrap">
      <header class="flow-head">
        <div class="flow-brand"><img src="icons/icon-192.png" alt="" width="28" height="28"><span>歌詞字幕エディタ</span></div>
        <ol class="stepper" id="flowSteps" aria-label="進行状況"></ol>
        <div class="step-mini" id="flowStepMini" aria-hidden="true"></div>
      </header>
      <main class="flow-main" id="flowMain"></main>
      <footer class="flow-actions" id="flowActions"></footer>
    </div>
    <input type="file" id="flowFile" accept="video/*,.mp4,.mov,.m4v" hidden>`;
  const main = $('#flowMain'), actions = $('#flowActions');

  // ---------------- 画面遷移 ----------------
  const isOpen = () => F.screen !== 'edit';
  const hashScreen = () => { const s = location.hash.replace(/^#\/?/, ''); return SCREENS.includes(s) ? s : null; };

  /** 画面を移る。履歴には「どの画面から来たか（prev）」も残し、「← 戻る」で履歴どおりに戻れるようにする */
  function go(screen, { replace = false } = {}) {
    const url = `${location.pathname}${location.search}#/${screen}`;
    const state = { screen, prev: F.screen };
    if (replace) history.replaceState(state, '', url);
    else if (hashScreen() !== screen) history.pushState(state, '', url);
    show(screen);
  }

  function show(screen) {
    if (screen === 'edit' && !P()) screen = 'start';
    const leavingEditor = F.screen === 'edit' && screen !== 'edit';
    F.screen = screen;
    if (leavingEditor) {
      // 編集画面を離れる：記録モードを終了・再生を止め、編集内容を保存しておく
      if (S.recordMode) api.setRecordMode(false);
      api.video.pause();
      if (S.dirty) api.saveProject(false);
    }
    document.body.classList.toggle('flow-open', isOpen());
    root.hidden = !isOpen();
    if (!isOpen()) { api.onEnterEditor?.(); return; }
    renderSteps();
    render();
    root.scrollTop = 0;
    main.scrollTop = 0;
  }

  window.addEventListener('popstate', () => show(hashScreen() || 'start'));

  function renderSteps() {
    const cur = STEP_OF[F.screen];
    $('#flowSteps').innerHTML = STEPS.map((name, i) => {
      const st = i < cur ? 'done' : i === cur ? 'current' : 'todo';
      return `<li class="${st}" ${i === cur ? 'aria-current="step"' : ''}><span class="step-no">${st === 'done' ? '✓' : i + 1}</span><span class="step-name">${name}</span></li>`;
    }).join('');
    $('#flowStepMini').innerHTML = `<span class="dots">${STEPS.map((_, i) => `<i class="${i < cur ? 'done' : i === cur ? 'current' : ''}"></i>`).join('')}</span><b>${cur + 1}/${STEPS.length}</b> ${STEPS[cur]}`;
  }

  function render() {
    actions.className = 'flow-actions';
    if (F.screen === 'start') renderStart();
    else if (F.screen === 'lyrics') renderLyrics();
    else if (F.screen === 'lyrics-new') renderLyricsNew();
    else if (F.screen === 'video') renderVideo();
  }

  /** このフローで準備中のプロジェクト（開いているプロジェクトと同じときだけ） */
  const target = () => (F.targetId && P()?.id === F.targetId ? P() : null);

  // ---------------- 1. スタート画面 ----------------
  async function renderStart() {
    main.innerHTML = `
      <section class="flow-hero">
        <img class="hero-logo" src="icons/icon-192.png" alt="" width="72" height="72">
        <h1>歌詞字幕エディタ</h1>
        <p class="muted">歌詞を選ぶ → 動画を開く → 再生しながらタイミングを記録</p>
        <button class="btn primary xl" data-a="new">＋ 新規プロジェクトを開始する</button>
      </section>
      <section class="flow-card">
        <div class="card-head"><h2>最近編集したプロジェクト</h2>
          <div class="inline" style="gap:6px;flex-wrap:wrap"><button class="btn sm" data-a="all">すべてのプロジェクト…</button><button class="btn sm" data-a="json">ファイル（JSON）から開く…</button></div></div>
        <ul class="recent-list" id="recentList"><li class="muted small">読み込み中…</li></ul>
      </section>`;
    actions.classList.add('mobile-only');
    actions.innerHTML = `<button class="btn primary lg grow" data-a="new">＋ 新規プロジェクトを開始する</button>`;
    const list = (await db.getAll('projects'))
      .filter(p => (p.lines || []).length || p.video) // 歌詞も動画も無い空のプロジェクトは出さない
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (F.screen !== 'start') return;
    const shown = list.slice(0, 8);
    $('#recentList').innerHTML = shown.length ? shown.map(p => {
      const lines = p.lines || [];
      const rec = lines.filter(l => p.timings?.[l.id]?.start != null).length;
      const v = p.video;
      const cur = p.id === P()?.id;
      return `<li data-id="${p.id}" class="${cur ? 'current' : ''}">
        <button class="recent-item" data-a="open">
          <span class="recent-title">${escapeHtml(p.name || '無題')}${cur ? ' <span class="tag">編集中</span>' : ''}</span>
          <span class="muted small">${lines.length ? `歌詞 ${lines.length} 行・記録 ${rec}/${lines.length}` : '歌詞未設定'}${v ? `・🎞 ${escapeHtml(v.name)}・${api.aspectLabel(v.width, v.height)}` : '・動画未設定'}</span>
          <span class="muted small">更新 ${fmtDate(p.updatedAt)}</span>
        </button></li>`;
    }).join('') + (list.length > shown.length ? `<li class="muted small">ほか ${list.length - shown.length} 件は「すべてのプロジェクト…」から開けます</li>` : '')
      : '<li class="muted small empty">まだプロジェクトはありません。「新規プロジェクトを開始する」から始めましょう。</li>';
  }

  async function startNew() {
    if (P() && S.dirty) await api.saveProject(false);
    F.targetId = null;
    F.selectedSetId = null;
    F.showDetail = false;
    F.query = '';
    F.videoError = null;
    go('lyrics');
  }

  /** 保存済みプロジェクトを開いたあと、準備の進み具合に応じた画面へ */
  function routeForProject() {
    const p = P();
    if (!p) return go('start');
    F.targetId = p.id;
    F.selectedSetId = p.lyricSetId;
    F.videoError = null;
    if (!p.lines.length) go('lyrics');
    else if (p.editor.setup === 'video' || (!p.video && p.editor.setup !== 'done')) go('video');
    else go('edit');
  }

  async function resume(id) {
    if (id !== P()?.id) await api.openProject(id); // openProject の中で onProjectOpened → routeForProject
    else routeForProject();
  }

  // ---------------- 2. 歌詞選択 ----------------
  function renderLyrics() {
    const p = target();
    if (!F.selectedSetId && p?.lyricSetId) F.selectedSetId = p.lyricSetId;
    const q = F.query.trim().toLowerCase();
    const lib = S.library;
    const items = lib.filter(s => !q || s.title.toLowerCase().includes(q) || (s.artist || '').toLowerCase().includes(q) || s.lines.some(l => l.text.toLowerCase().includes(q)));
    const sel = lib.find(s => s.id === F.selectedSetId) || null;
    if (!sel) F.showDetail = false;
    const hasDraft = !!(F.draft.title.trim() || F.draft.text.trim());
    main.innerHTML = `
      <div class="flow-title"><h2>使う歌詞を選んでください</h2>
        <p class="muted small">歌詞ライブラリの歌詞は、このプロジェクトにコピーして使います（ライブラリの原本や、同じ歌詞を使う他のプロジェクトのタイミングは変わりません）。</p></div>
      <section class="flow-card new-lyrics-card">
        <button class="btn primary lg" data-a="newLyrics">＋ 新しい歌詞を登録する</button>
        ${hasDraft ? `<span class="small" style="color:var(--warn)">入力途中の歌詞があります${F.draft.title.trim() ? `（${escapeHtml(F.draft.title.trim())}）` : ''}</span>` : '<span class="muted small">楽曲名と歌詞を入力して、歌詞ライブラリに保存します</span>'}
      </section>
      <section class="flow-card lyr-layout ${F.showDetail ? 'show-detail' : ''}">
        <div class="lyr-list-col">
          <div class="card-head"><h2>登録済みの歌詞から選ぶ</h2><span class="muted small">${lib.length} 曲</span></div>
          ${lib.length > 4 ? `<input type="search" id="flowLyrSearch" class="lyr-search" placeholder="曲名・アーティスト・歌詞で検索" value="${escapeHtml(F.query)}">` : ''}
          <ul class="lyr-list" id="flowLyrList">${items.length ? items.map(s => `
            <li><button class="lyr-item ${s.id === F.selectedSetId ? 'selected' : ''}" data-a="pick" data-id="${s.id}" aria-pressed="${s.id === F.selectedSetId}">
              <span class="lyr-title">${escapeHtml(s.title || '（無題）')}${s.artist ? `<span class="muted small">　${escapeHtml(s.artist)}</span>` : ''}</span>
              <span class="lyr-preview muted small">${escapeHtml(s.lines.slice(0, 2).map(l => l.text).join(' / '))}</span>
              <span class="muted small">${s.lines.length} 行・更新 ${fmtDate(s.updatedAt || s.createdAt)}</span>
            </button></li>`).join('') : `<li class="muted small empty">${lib.length ? '一致する歌詞はありません' : 'まだ歌詞が登録されていません。上の「新しい歌詞を登録する」から登録してください。'}</li>`}</ul>
        </div>
        <div class="lyr-detail-col" id="flowLyrDetail">${sel ? `
          <button class="btn sm ghost back-to-list" data-a="closeDetail">← 一覧に戻る</button>
          <div class="lyr-detail-head"><h3>${escapeHtml(sel.title || '（無題）')}</h3>
            <div class="muted small">${sel.artist ? escapeHtml(sel.artist) + '・' : ''}${sel.lines.length} 行・登録 ${fmtDate(sel.createdAt)}・更新 ${fmtDate(sel.updatedAt || sel.createdAt)}</div></div>
          <ol class="lyr-detail-lines">${linesHtml(sel.lines)}</ol>`
          : '<div class="muted small lyr-detail-empty">左の一覧から歌詞を選ぶと、ここに内容が表示されます。</div>'}</div>
      </section>`;
    actions.innerHTML = `<button class="btn lg" data-a="back">← 戻る</button>
      <button class="btn primary lg grow" data-a="useSet" ${sel ? '' : 'disabled'}>${sel ? 'この歌詞で次へ →' : '歌詞を選んでください'}</button>`;
    const search = $('#flowLyrSearch');
    if (search) search.oninput = () => {
      F.query = search.value;
      const pos = search.selectionStart;
      renderLyrics();
      const s2 = $('#flowLyrSearch'); s2.focus(); s2.setSelectionRange(pos, pos);
    };
  }

  /** 歌詞を決めて動画読み込みへ。初回はここでプロジェクトを作る */
  async function confirmLyrics(set) {
    let p = target();
    if (p) {
      if (p.lyricSetId !== set.id || !p.lines.length) {
        const rec = p.lines.filter(l => p.timings[l.id]?.start != null).length;
        if (rec && !(await api.confirmDialog(`このプロジェクトの歌詞を「${set.title}」に変更しますか？\n記録済みのタイミング（${rec} 行）は消去されます。`, { ok: '変更する', danger: true }))) return;
        const oldTitle = p.lyricTitle;
        p.lines = deepClone(set.lines);
        p.timings = {};
        p.lyricSetId = set.id;
        p.lyricTitle = set.title;
        p.editor.cursor = 0;
        if (!p.name || p.name === '新しいプロジェクト' || p.name === oldTitle) p.name = set.title;
        if (p.editor.setup !== 'done') p.editor.setup = 'video';
        api.activateProject(p);
        await api.saveProject(false);
      }
    } else {
      const cur = P();
      if (cur && S.dirty) await api.saveProject(false);
      // 起動直後の空のプロジェクト（歌詞も動画も無い）は作り直さずに使う
      const empty = cur && !cur.lines.length && !cur.video && !Object.keys(cur.timings).length;
      p = empty ? cur : api.newProject(set.title);
      if (cur && !empty) { p.editor.recordKey = cur.editor.recordKey; p.editor.recordOffset = cur.editor.recordOffset; }
      p.name = set.title;
      p.lyricSetId = set.id;
      p.lyricTitle = set.title;
      p.lines = deepClone(set.lines); // ライブラリの原本ではなくコピーを使う
      p.timings = {};
      p.editor.cursor = 0;
      p.editor.setup = 'video';
      p.createdAt = empty ? Date.now() : p.createdAt;
      api.activateProject(p);
      await api.saveProject(false);
      await api.restoreVideo(); // 前のプロジェクトの動画を外す
      F.targetId = p.id;
    }
    F.selectedSetId = set.id;
    F.videoError = null;
    go('video');
  }

  // ---------------- 2-A. 新しい歌詞を登録 ----------------
  function renderLyricsNew() {
    const d = F.draft;
    main.innerHTML = `
      <div class="flow-title"><h2>新しい歌詞を登録する</h2>
        <p class="muted small">1 行が 1 つの字幕になります。登録した歌詞は歌詞ライブラリに保存され、ほかのプロジェクトでも使えます。タイミングは次の画面以降で記録します。</p></div>
      <section class="flow-card new-lyrics-form">
        <label class="block"><span>楽曲名 <b class="req">必須</b></span><input id="nlTitle" value="${escapeHtml(d.title)}" placeholder="例：朝焼けのカーテン" autocomplete="off"></label>
        <label class="block"><span>アーティスト（任意）</span><input id="nlArtist" value="${escapeHtml(d.artist)}" autocomplete="off"></label>
        <label class="block"><span>歌詞本文 <b class="req">必須</b>　<span class="muted">（1 行＝1 字幕。空行は無視されます。<b>[Aメロ]</b> のように括弧だけの行はセクション名）</span></span>
          <textarea id="nlText" rows="10" placeholder="[Aメロ]&#10;もう朝焼けがカーテンを染める&#10;君のいない部屋で目を覚ます&#10;&#10;[サビ]&#10;昨日の続きを探している">${escapeHtml(d.text)}</textarea></label>
        <div class="block"><span class="small">1 行ずつ追加</span>
          <div class="line-adder"><input id="nlLine" placeholder="歌詞を 1 行入力して Enter（または「行を追加」）" enterkeyhint="enter" autocomplete="off"><button class="btn" data-a="addLine">＋ 行を追加</button></div></div>
        <div class="nl-preview-head"><span id="nlCount" class="small"></span><button class="btn sm ghost" data-a="clearDraft">入力を消去</button></div>
        <ol class="nl-preview" id="nlPreview"></ol>
      </section>`;
    actions.innerHTML = `<button class="btn lg" data-a="back">← 戻る</button><button class="btn primary lg grow" data-a="saveNew">保存して次へ →</button>`;
    const sync = () => {
      d.title = $('#nlTitle').value; d.artist = $('#nlArtist').value; d.text = $('#nlText').value;
      saveDraft(d);
      const lines = parseLyricsText(d.text);
      const secs = lines.filter(l => l.section).length;
      $('#nlCount').textContent = lines.length ? `${lines.length} 行${secs ? `・セクション ${secs} 個` : ''}` : 'まだ歌詞がありません';
      $('#nlPreview').innerHTML = linesHtml(lines);
    };
    ['#nlTitle', '#nlArtist', '#nlText'].forEach(s => $(s).addEventListener('input', sync));
    $('#nlLine').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addLine(); } });
    sync();
    if (!d.title) setTimeout(() => $('#nlTitle')?.focus(), 50);
  }

  function addLine() {
    const inp = $('#nlLine');
    const v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    const ta = $('#nlText');
    ta.value = ta.value.replace(/\s+$/, '') + (ta.value.trim() ? '\n' : '') + v;
    ta.dispatchEvent(new Event('input'));
    ta.scrollTop = ta.scrollHeight;
    inp.value = '';
    inp.focus();
  }

  async function saveNewLyrics() {
    const d = F.draft;
    const title = d.title.trim();
    const parsed = parseLyricsText(d.text);
    if (!title) { api.toast('楽曲名を入力してください', true); $('#nlTitle')?.focus(); return; }
    if (!parsed.length) { api.toast('歌詞を 1 行以上入力してください', true); $('#nlText')?.focus(); return; }
    const set = {
      id: uid('s_'), title, artist: d.artist.trim(), createdAt: Date.now(), order: S.library.length,
      lines: parsed.map(x => ({ id: uid('l_'), text: x.text, ...(x.section ? { section: x.section } : {}) })),
    };
    await api.saveLyricSet(set); // 歌詞ライブラリに保存（タイミングは持たない）
    F.draft = { title: '', artist: '', text: '' };
    saveDraft(F.draft);
    api.toast(`歌詞「${title}」を歌詞ライブラリに保存しました`);
    // 「戻る」で歌詞選択に戻ったとき、登録した歌詞が選ばれた状態にする
    history.replaceState({ screen: 'lyrics' }, '', `${location.pathname}${location.search}#/lyrics`);
    F.screen = 'lyrics';
    await confirmLyrics(S.library.find(s => s.id === set.id) || set);
  }

  // ---------------- 3. 動画読み込み ----------------
  function renderVideo() {
    const p = P();
    const loaded = !!(S.file && p?.video);
    const v = p?.video;
    const e = F.videoError;
    main.innerHTML = `
      <div class="flow-title"><h2>動画を開く</h2>
        <p class="small">歌詞：<b>${escapeHtml(p?.lyricTitle || '（未設定）')}</b>${p?.lines.length ? `（${p.lines.length} 行）` : ''}　<button class="btn sm ghost" data-a="back">変更</button></p></div>
      <section class="flow-card video-card">
        ${F.videoBusy ? '<div class="vid-busy">動画を読み込んでいます…</div>' : ''}
        ${e ? `<div class="vid-error" role="alert"><b>動画を読み込めませんでした</b><div>${escapeHtml(e.cause)}</div>
          <ul class="small">${e.tips.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>
          <button class="btn primary" data-a="pickVideo">もう一度ファイルを選ぶ</button></div>` : ''}
        ${loaded ? `
          <div class="vid-frame ${v.height > v.width ? 'portrait' : v.height === v.width ? 'square' : 'landscape'}"><video id="flowPreview" src="${S.videoUrl}" controls playsinline preload="metadata"></video></div>
          <dl class="vid-info">
            <dt>ファイル</dt><dd>${escapeHtml(v.name)}（${fmtBytes(v.size)}）</dd>
            <dt>長さ</dt><dd>${fmtTime(v.duration, false)}</dd>
            <dt>解像度</dt><dd>${v.width}×${v.height}</dd>
            <dt>アスペクト比</dt><dd>${api.aspectLabel(v.width, v.height)}</dd>
          </dl>
          <button class="btn" data-a="pickVideo">別の動画を選ぶ</button>`
        : !F.videoBusy && !e ? `
          <div class="vid-drop" id="flowDrop">
            <div class="drop-icon">🎬</div>
            <button class="btn primary lg" data-a="pickVideo">動画ファイルを選択</button>
            <p class="muted small">MP4 / MOV（iPhone の縦動画 9:16、横 16:9、正方形 1:1 など）<span class="pc-only"><br>ここにドラッグ＆ドロップもできます</span></p>
            ${v ? `<p class="small" style="color:var(--warn)">前回の動画「${escapeHtml(v.name)}」を、もう一度選んでください。</p>` : ''}
          </div>` : ''}
      </section>`;
    actions.innerHTML = `<button class="btn lg" data-a="back">← 戻る</button>
      <button class="btn accent lg grow" data-a="startEdit" ${loaded ? '' : 'disabled'} title="${loaded ? '' : '動画を読み込むと押せます'}">${loaded ? '編集を開始する ▶' : '動画を読み込むと編集を開始できます'}</button>`;
    const drop = $('#flowDrop');
    if (drop) {
      drop.addEventListener('dragover', ev => { ev.preventDefault(); drop.classList.add('dragover'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
      drop.addEventListener('drop', async ev => {
        ev.preventDefault();
        drop.classList.remove('dragover');
        const item = [...ev.dataTransfer.items].find(i => i.kind === 'file');
        if (!item) return;
        let handle = null;
        try { handle = await item.getAsFileSystemHandle?.(); } catch { /* 非対応 */ }
        const f = handle?.kind === 'file' ? await handle.getFile() : item.getAsFile();
        if (f) useVideoFile(f, handle?.kind === 'file' ? handle : null);
      });
    }
  }

  /** ファイル選択（iPhone ではユーザー操作の直後に開く必要があるため、確認より先に選ばせる） */
  async function pickVideo() {
    if (window.showOpenFilePicker) {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: '動画 (MP4 / MOV)', accept: { 'video/mp4': ['.mp4', '.m4v'], 'video/quicktime': ['.mov'] } }] });
        await useVideoFile(await h.getFile(), h);
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    $('#flowFile').click();
  }
  $('#flowFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) useVideoFile(f, null); });

  async function useVideoFile(file, handle) {
    const p = P();
    if (!p) return;
    // 差し替えの確認（記録済みのタイミングがある場合）
    const rec = p.lines.filter(l => p.timings[l.id]?.start != null).length;
    const same = p.video && p.video.name === file.name && p.video.size === file.size;
    if (S.file && !same && rec && !(await api.confirmDialog(`動画を「${file.name}」に差し替えますか？\n記録済みのタイミング（${rec} 行）はそのまま残ります。`, { ok: '差し替える' }))) return;
    F.videoError = null;
    F.videoBusy = true;
    renderVideo();
    const err = await checkPlayable(file);
    if (err) {
      F.videoBusy = false;
      F.videoError = err;
      if (F.screen === 'video') renderVideo();
      return;
    }
    await api.loadVideoFile(file, handle);
    F.videoBusy = false;
    if (S.file !== file) F.videoError = { cause: 'このブラウザでは再生できない動画です。', tips: TIPS };
    else { p.editor.setup = p.editor.setup === 'done' ? 'done' : 'video'; api.saveProject(false); }
    if (F.screen === 'video') renderVideo();
  }

  async function startEdit() {
    const p = P();
    if (!S.file || !p) return;
    p.editor.setup = 'done';
    await api.saveProject(false);
    go('edit');
  }

  // ---------------- 操作 ----------------
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === 'new') startNew();
    else if (a === 'all') api.openProjectsDialog();
    else if (a === 'json') $('#fileJson').click();
    else if (a === 'open') resume(b.closest('li').dataset.id);
    else if (a === 'back') back();
    else if (a === 'newLyrics') go('lyrics-new');
    else if (a === 'pick') {
      F.selectedSetId = b.dataset.id;
      F.showDetail = true;
      const scroll = $('#flowLyrList')?.scrollTop;
      renderLyrics();
      if (scroll != null) $('#flowLyrList').scrollTop = scroll;
      if (matchMedia('(max-width: 700px)').matches) main.scrollTop = 0;
    }
    else if (a === 'closeDetail') { F.showDetail = false; renderLyrics(); }
    else if (a === 'useSet') { const set = S.library.find(s => s.id === F.selectedSetId); if (set) confirmLyrics(set); }
    else if (a === 'addLine') addLine();
    else if (a === 'clearDraft') {
      if (!(await api.confirmDialog('入力中の楽曲名と歌詞を消去しますか？', { ok: '消去する', danger: true }))) return;
      F.draft = { title: '', artist: '', text: '' }; saveDraft(F.draft); renderLyricsNew();
    }
    else if (a === 'saveNew') saveNewLyrics();
    else if (a === 'pickVideo') pickVideo();
    else if (a === 'startEdit') startEdit();
  });

  /** 前の画面へ（入力した内容・選んだ歌詞は残す） */
  function back() {
    const prev = { lyrics: 'start', 'lyrics-new': 'lyrics', video: 'lyrics' }[F.screen] || 'start';
    if (F.screen === 'lyrics' && F.showDetail && matchMedia('(max-width: 700px)').matches) { F.showDetail = false; renderLyrics(); return; }
    // 履歴の1つ前が同じ画面なら履歴で戻る（ブラウザの戻ると同じ動き）
    if (history.state?.prev === prev) history.back();
    else go(prev);
  }

  return {
    isOpen,
    go,
    startNew,
    /** 編集画面から「動画」へ戻る */
    backToVideo() { F.targetId = P()?.id || null; F.selectedSetId = P()?.lyricSetId || null; F.videoError = null; go('video'); },
    home() { go('start'); },
    /** プロジェクトを開いたとき（スタート画面・一覧・JSON 読み込みから）：フロー表示中なら適切な画面へ */
    onProjectOpened() { if (isOpen()) routeForProject(); },
    /** 起動時の画面。編集中の再読み込み（#/edit）やライブラリからの「この歌詞を使う」では編集画面のまま */
    init({ editor = false } = {}) {
      const h = hashScreen();
      let s = editor ? 'edit' : h || 'start';
      if (s === 'video' && !P()?.lines.length) s = 'lyrics';
      if (s === 'video' || s === 'lyrics') { F.targetId = P()?.id || null; F.selectedSetId = P()?.lyricSetId || null; }
      history.replaceState({ screen: s }, '', `${location.pathname}${location.search}#/${s}`);
      F.screen = 'edit';
      show(s);
    },
    refresh() { if (isOpen()) render(); },
  };
}

const TIPS = [
  'MP4（H.264）または MOV の動画を選んでください。',
  'iPhone で撮った動画は、写真アプリから「ファイルに保存」してから選ぶと読み込めることがあります。',
  'HEVC（H.265）や ProRes の動画は、ブラウザによっては再生できません。写真アプリや QuickTime で「互換性優先」「H.264」で書き出してから選んでください。',
  'ファイルが壊れていないか、ほかのアプリで再生できるか確認してください。',
];

/** 再生できる動画か先に確かめる（失敗したら原因と対処を返す） */
function checkPlayable(file) {
  if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
    return Promise.resolve({ cause: `「${file.name}」は動画ファイルではないようです（種類: ${file.type || '不明'}）。`, tips: TIPS });
  }
  return new Promise(resolve => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); resolve(r); };
    const timer = setTimeout(() => finish({ cause: '動画の情報を 20 秒以内に読み取れませんでした（大きすぎる・壊れている・形式に対応していない可能性があります）。', tips: TIPS }), 20000);
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    v.onloadedmetadata = () => finish(v.videoWidth && v.videoHeight ? null : { cause: '映像が見つかりませんでした（音声だけのファイルの可能性があります）。', tips: TIPS });
    v.onerror = () => finish({ cause: `このブラウザでは再生できない動画です（${v.error?.code === 4 ? '形式またはコーデックに非対応' : '読み込みエラー'}）。`, tips: TIPS });
    v.src = url;
  });
}

/** 歌詞の行の一覧（セクション名の行は番号に数えない） */
function linesHtml(lines) {
  return lines.map((l, i) => `${l.section ? `<li class="sec">🏷 ${escapeHtml(l.section)}</li>` : ''}<li value="${i + 1}">${escapeHtml(l.text)}</li>`).join('');
}

function fmtDate(t) {
  if (!t) return '—';
  return new Date(t).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function loadDraft() {
  try { return { title: '', artist: '', text: '', ...JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') }; } catch { return { title: '', artist: '', text: '' }; }
}
function saveDraft(d) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* 保存できなくてもメモリ上には残る */ }
}
