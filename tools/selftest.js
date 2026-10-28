// 自動セルフテスト：ロジックの単体テスト + 各種アスペクト比の書き出し検証（音ズレ・映像タイミング・字幕表示）
import { makeTestVideo, detectBeeps } from './testvideo.js';
import { exportVideo } from '../js/exporter.js';
import { buildCues, activeCueAt, firstUnrecorded } from '../js/cues.js';
import { mergeLines, parseTime, fmtTime } from '../js/util.js';
import { DEFAULT_STYLE } from '../js/subtitle.js';
import { readMovie, describeTracks, RangeReader } from '../js/demux.js';

const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); return !!cond; };

export function unitTests() {
  const lines = [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }];
  let cues = buildCues(lines, { a: { start: 1, end: null }, b: { start: 2.5, end: null } }, 10);
  ok('自動終了＝次の開始', cues[0].end === 2.5, JSON.stringify(cues.map(c => [c.start, c.end])));
  ok('最後の行は動画終了まで', cues[1].end === 10);
  ok('記録位置＝未記録の先頭', firstUnrecorded(lines, { a: { start: 1 } }) === 1);
  ok('時刻の字幕検索', activeCueAt(cues, 2.4)?.lineId === 'a' && activeCueAt(cues, 2.5)?.lineId === 'b' && activeCueAt(cues, 0.5) == null);
  cues = buildCues(lines, { a: { start: 1, end: 1.8 }, b: { start: 2.5, end: null } }, 10);
  ok('手動終了時刻（間奏で消す）', activeCueAt(cues, 2.0) == null && cues[0].end === 1.8);
  // 並べ替えてもタイミングは行に紐づく
  const re = [lines[2], lines[0], lines[1]];
  cues = buildCues(re, { a: { start: 1 }, b: { start: 2.5 } }, 10);
  ok('並べ替え後もタイミング維持', cues.map(c => c.lineId).join() === 'a,b' && cues[0].index === 1);
  const m = mergeLines(lines, ['A', 'X', 'B', 'C改']);
  ok('歌詞再編集で行IDを維持', m[0].id === 'a' && m[2].id === 'b' && m[3].id === 'c' && !['a', 'b', 'c'].includes(m[1].id), JSON.stringify(m));
  const m2 = mergeLines(lines, ['A', 'B改', 'C']);
  ok('文字修正した行もIDを維持', m2.map(x => x.id).join() === 'a,b,c', JSON.stringify(m2));
  const m3 = mergeLines(lines, ['C', 'A', 'B']);
  ok('行の入れ替えでもID維持', m3.find(x => x.text === 'C').id === 'c' && m3.find(x => x.text === 'A').id === 'a' && m3.find(x => x.text === 'B').id === 'b', JSON.stringify(m3));
  ok('時刻の解析', parseTime('1:23.456') === 83.456 && parseTime('12.5') === 12.5 && parseTime('abc') == null);
  ok('時刻の表示', fmtTime(83.456) === '1:23.456');
}

async function decodeFrames(blob, times) {
  const r = await readMovie(new File([blob], 'o.mp4'));
  const T = describeTracks(r.mp4, r.info, r.moovBytes), V = T.video;
  const reader = new RangeReader(new File([blob], 'o.mp4'));
  const c = new OffscreenCanvas(V.codedWidth, V.codedHeight), ctx = c.getContext('2d', { willReadFrequently: true });
  const want = times.map(t => Math.round(t * 1e6));
  const out = {};
  const dec = new VideoDecoder({
    output: f => {
      const hit = want.find(w => Math.abs(w - f.timestamp) < 17000);
      if (hit != null && !(hit in out)) {
        ctx.drawImage(f, 0, 0);
        const corner = ctx.getImageData(5, 5, 1, 1).data[0];
        const d = ctx.getImageData(c.width * 0.25, c.height * 0.3, c.width * 0.5, c.height * 0.4).data;
        let white = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
        out[hit] = { corner, white };
      }
      f.close();
    }, error: e => { throw e; },
  });
  dec.configure({ codec: V.codec, codedWidth: V.codedWidth, codedHeight: V.codedHeight, description: V.description });
  for (const s of V.samples) dec.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: Math.round(s.cts / V.timescale * 1e6), data: await reader.read(s.offset, s.size) }));
  await dec.flush();
  return { T, frames: times.map(t => out[Math.round(t * 1e6)]) };
}

export async function exportTest(label, genOpts, style = {}) {
  const src = await makeTestVideo({ seconds: 5, ...genOpts });
  return verifyFile(src, label, genOpts.width, genOpts.height, style);
}

/** テストパターン動画（毎秒ビープ＋フラッシュ）を書き出して検証する。外部で変換した MOV などにも使える */
export async function verifyFile(src, label, width, height, style = {}) {
  const genOpts = { width, height };
  // 字幕：1.5〜2.5 / 2.5〜(手動)3.4 / 4.0〜終了。アニメなしで画素判定
  const lines = [{ id: 'a', text: 'もう朝焼けがカーテンを染める' }, { id: 'b', text: '君のいない部屋で目を覚ます' }, { id: 'c', text: '午前5時 12月25日' }];
  const cues = buildCues(lines, { a: { start: 1.5, end: null }, b: { start: 2.5, end: 3.4 }, c: { start: 4.0, end: null } }, 5);
  const st = { ...DEFAULT_STYLE, animation: 'none', bgMode: 'none', ...style };
  const t0 = performance.now();
  const res = await exportVideo({ file: src, cues, style: st, onProgress: () => {} });
  const sec = (performance.now() - t0) / 1000;
  const expW = genOpts.width & ~1, expH = genOpts.height & ~1;
  ok(`[${label}] 解像度・アスペクト比維持 ${res.width}×${res.height}`, res.width === expW && res.height === expH);
  const bo = await detectBeeps(res.blob);
  let bs = null;
  try { bs = await detectBeeps(src); } catch { /* Safari は MOV の音声をデコードできないため、出力側だけで検証する */ }
  if (bs) {
    const maxDiff = Math.max(...bs.map((b, i) => Math.abs(b - (bo[i] ?? 99))));
    ok(`[${label}] 音声タイミング一致（最大誤差 ${(maxDiff * 1000).toFixed(2)}ms）`, bs.length === bo.length && maxDiff < 0.002, `src=${bs.map(x => x.toFixed(3))} out=${bo.map(x => x.toFixed(3))}`);
  } else {
    // テスト動画のビープは毎秒ちょうど → 出力でも 1.000 秒間隔・先頭が 0.1 秒未満であること
    const gaps = bo.slice(1).map((b, i) => Math.abs(b - bo[i] - 1));
    const maxGap = Math.max(0, ...gaps);
    ok(`[${label}] 音声タイミング（出力のビープ間隔の誤差 ${(maxGap * 1000).toFixed(2)}ms）`, bo.length >= 4 && bo[0] < 0.1 && maxGap < 0.002, `out=${bo.map(x => x.toFixed(3))}`);
  }
  const { T, frames } = await decodeFrames(res.blob, [0.967, 1.0, 1.4, 1.6, 2.0, 2.6, 3.3, 3.6, 4.1, 4.9]);
  const [f0967, f1, f14, f16, f20, f26, f33, f36, f41, f49] = frames;
  ok(`[${label}] 映像タイミング一致（1.000秒のフラッシュ）`, f0967 && f1 && f0967.corner < 200 && f1.corner > 240, JSON.stringify([f0967, f1]));
  ok(`[${label}] 字幕：開始前は非表示 / 開始後は表示`, f14.white < 50 && f16.white > 300, JSON.stringify([f14, f16]));
  ok(`[${label}] 字幕：手動終了後は非表示・次の行で再表示`, f26.white > 300 && f33.white > 300 && f36.white < 50 && f41.white > 300 && f49.white > 300, JSON.stringify([f20, f26, f33, f36, f41, f49]));
  ok(`[${label}] 出力は回転なし・H.264/AAC`, T.video.rotation === 0 && /^avc1/.test(T.video.codec) && /^mp4a/.test(T.audio?.codec || ''));
  results.push({ name: `[${label}] 書き出し時間 ${sec.toFixed(1)}秒 / ${res.frames}フレーム / 音声:${res.audioMode}`, pass: true });
  return res;
}

export async function runAll(log = () => {}) {
  results.length = 0;
  unitTests();
  log(results);
  const cases = [
    ['iPhone風 縦9:16 回転90°', { width: 1080, height: 1920, rotation: 90 }, {}],
    ['縦9:16 縦書き', { width: 1080, height: 1920 }, { writingMode: 'vertical', posX: 50 }],
    ['横16:9', { width: 1920, height: 1080 }, {}],
    ['正方形1:1 ボックス背景', { width: 1080, height: 1080 }, { bgMode: 'box' }],
    ['4K縦 2160×3840', { width: 2160, height: 3840 }, {}],
  ];
  try {
    if ((await VideoEncoder.isConfigSupported({ codec: 'hvc1.1.6.L123.B0', width: 1080, height: 1920, bitrate: 4e6 })).supported) cases.push(['HEVC 縦9:16', { width: 1080, height: 1920, codec: 'hevc' }, {}]);
  } catch { /* HEVC エンコード非対応環境 */ }
  for (const [label, gen, style] of cases) {
    try { await exportTest(label, gen, style); } catch (e) { ok(`[${label}] 例外なし`, false, String(e.stack || e)); }
    log(results);
  }
  return results;
}
export { results };
