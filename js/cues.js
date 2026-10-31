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

/**
 * 歌詞ブロックを削除しても、残りのブロックの表示区間が変わらないようにする。
 * 終了時刻が「自動」のブロックは削除で次の開始がずれると終了が延びてしまうため、
 * 削除前の終了時刻を固定（明示的な end）にして、削除した区間を字幕なしの空白として残す。
 * @param removeIds 削除する行IDの配列。timings は直接書き換える（removeIds のタイミングも削除する）
 */
export function removeCuesKeepingGaps(lines, timings, duration, removeIds) {
  const remove = new Set(removeIds);
  const before = new Map(buildCues(lines, timings, duration).map(c => [c.lineId, c.end]));
  for (const id of remove) delete timings[id];
  const rest = lines.filter(l => !remove.has(l.id));
  for (const c of buildCues(rest, timings, duration)) {
    const old = before.get(c.lineId);
    if (old != null && isFinite(old) && Math.abs(c.end - old) > 1e-6 && timings[c.lineId].end == null) {
      timings[c.lineId].end = +old.toFixed(3);
    }
  }
}

/**
 * セクションごとの書き出し区間。区間 = そのセクションで記録済みの行の最初の開始〜最後の終了。
 * 記録済みの行が無いセクションは start/end が null。
 * @param sections util.sectionsOf() の結果
 * @returns {{name, from, to, lineIds, start, end, cues}[]}
 */
export function sectionRanges(sections, cues) {
  return sections.map(s => {
    const ids = new Set(s.lineIds);
    const own = cues.filter(c => ids.has(c.lineId));
    if (!own.length) return { ...s, start: null, end: null, cues: [] };
    return { ...s, start: Math.min(...own.map(c => c.start)), end: Math.max(...own.map(c => c.end)), cues: own };
  });
}
