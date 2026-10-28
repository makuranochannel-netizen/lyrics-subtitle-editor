// 字幕タイミングモデル
// 歌詞（project.lines: [{id,text}]）とタイミング（project.timings: {lineId: {start,end}}）は分離して保持する。
// end が null の場合は「自動」＝ 次に表示される歌詞の開始時刻（なければ動画の終了時刻）。

/**
 * 表示用の字幕（cue）リストを開始時刻順で返す。
 * @returns {{lineId,text,index,start,end,explicitEnd}[]}
 */
export function buildCues(lines, timings, duration) {
  const list = [];
  lines.forEach((l, index) => {
    const t = timings[l.id];
    if (t && t.start != null && isFinite(t.start)) list.push({ lineId: l.id, text: l.text, index, start: t.start, explicitEnd: t.end ?? null });
  });
  list.sort((a, b) => a.start - b.start || a.index - b.index);
  const dur = duration && isFinite(duration) ? duration : Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    let next = null;
    for (let j = i + 1; j < list.length; j++) if (list[j].start > c.start) { next = list[j].start; break; }
    const auto = next ?? dur;
    c.end = c.explicitEnd != null ? Math.max(c.start, c.explicitEnd) : Math.max(c.start, auto);
  }
  return list;
}

/** 時刻 t に表示する字幕（複数重なる場合は後から始まったもの） */
export function activeCueAt(cues, t) {
  let best = null;
  for (const c of cues) {
    if (c.start > t) break;
    if (t < c.end) best = c;
  }
  return best;
}

/** 次に記録すべき行のインデックス（未記録の先頭）。全て記録済みなら lines.length */
export function firstUnrecorded(lines, timings) {
  const i = lines.findIndex(l => !(timings[l.id] && timings[l.id].start != null));
  return i < 0 ? lines.length : i;
}
