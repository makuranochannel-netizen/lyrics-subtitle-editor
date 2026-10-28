// エディタと歌詞ライブラリ（別ページ）の連携用の共通定義
export const LIB_CHANNEL = 'lyrics-subtitle-editor';
/** エディタが閉じている時に「この歌詞を使う」を押した場合の読み込み待ち（localStorage） */
export const PENDING_KEY = 'lse.pendingUseLyricSet';

/** 歌詞ライブラリを開く。PC は別タブ、iPhone / ホーム画面アプリは同じ画面で開く */
export function openLibraryPage({ newSet = false } = {}) {
  const url = 'library.html' + (newSet ? '?new=1' : '');
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (standalone || touch) { location.href = url; return; }
  const w = window.open(url, 'lse-library');
  if (!w) location.href = url; // ポップアップがブロックされた場合
  else w.focus();
}
