// MP4 / MOV のメタデータ（moov）だけを読み、サンプル表を取得する。
// 動画全体をメモリに載せず、各サンプルは File.slice() で必要な時に読む（大きな動画向け）。
/* global MP4Box, DataStream */

async function readBoxes(file) {
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= file.size) {
    const dv = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = dv.getUint32(0);
    const type = String.fromCharCode(dv.getUint8(4), dv.getUint8(5), dv.getUint8(6), dv.getUint8(7));
    if (size === 1) size = Number(dv.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) throw new Error(`不正なボックス構造です (${type} @${pos})`);
    boxes.push({ type, pos, size });
    pos += size;
  }
  return boxes;
}

export async function readMovie(file) {
  if (!window.MP4Box) throw new Error('mp4box.js が読み込まれていません');
  const boxes = await readBoxes(file);
  const moov = boxes.find(b => b.type === 'moov');
  if (!moov) throw new Error('moov ボックスが見つかりません（MP4/MOV ではない可能性があります）');
  // ftyp + moov だけを連結して mp4box に渡す（stco のオフセットは元ファイルの絶対位置のまま使える）
  const parts = [boxes.find(b => b.type === 'ftyp'), moov].filter(Boolean);
  const total = parts.reduce((a, b) => a + b.size, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(new Uint8Array(await file.slice(p.pos, p.pos + p.size).arrayBuffer()), o); o += p.size; }
  const mp4 = MP4Box.createFile();
  let info = null, err = null;
  mp4.onReady = i => { info = i; };
  mp4.onError = e => { err = e; };
  const ab = buf.buffer;
  ab.fileStart = 0;
  mp4.appendBuffer(ab);
  mp4.flush();
  if (err) throw new Error('MP4解析エラー: ' + err);
  if (!info) throw new Error('MP4のメタデータを解析できませんでした');
  return { mp4, info, moovBytes: buf, moovOffset: parts.length > 1 ? parts[0].size : 0 };
}

function editInfo(trak, track, movieTimescale) {
  let mediaStart = 0, delay = 0;
  const entries = trak.edts?.elst?.entries || [];
  for (const e of entries) {
    if (e.media_time === -1 || e.media_time === 0xFFFFFFFF) delay += e.segment_duration / movieTimescale;
    else { mediaStart = e.media_time / track.timescale; break; }
  }
  return { mediaStart, delay };
}

function rotationOf(trak) {
  const m = trak.tkhd?.matrix;
  if (!m) return 0;
  const a = m[0] / 65536, b = m[1] / 65536;
  const deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
  return ((deg % 360) + 360) % 360;
}

function codecDescription(trak) {
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  if (!box) return undefined;
  const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
  box.write(stream);
  return new Uint8Array(stream.buffer, 8); // ボックスヘッダ(8byte)を除く
}

// QuickTime の音声サンプル記述（v1/v2 や wave ボックス内の esds）は mp4box が解析しないため、生バイトから esds を探す
function readDescLen(b, p) {
  let len = 0, i = 0;
  for (; i < 4; i++) { const c = b[p + i]; len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) { i++; break; } }
  return [len, p + i];
}
function parseEsdsBytes(b) {
  for (let i = 4; i + 4 < b.length; i++) {
    if (b[i] !== 0x65 || b[i + 1] !== 0x73 || b[i + 2] !== 0x64 || b[i + 3] !== 0x73) continue; // 'esds'
    let p = i + 8; // type(4) + version/flags(4)
    if (b[p] !== 0x03) continue;
    let len;
    [len, p] = readDescLen(b, p + 1);
    const flags = b[p + 2];
    p += 3;
    if (flags & 0x80) p += 2;
    if (flags & 0x40) p += 1 + b[p];
    if (flags & 0x20) p += 2;
    if (b[p] !== 0x04) continue;
    [len, p] = readDescLen(b, p + 1);
    const oti = b[p];
    p += 13;
    if (b[p] !== 0x05) continue;
    [len, p] = readDescLen(b, p + 1);
    const dsi = b.slice(p, p + len);
    const aot = dsi.length ? (dsi[0] >> 3) : 2;
    return { description: dsi, codec: oti === 0x40 ? `mp4a.40.${aot}` : `mp4a.${oti.toString(16)}` };
  }
  return null;
}

function findDescTag(desc, tag) {
  if (!desc) return null;
  if (desc.tag === tag) return desc;
  for (const d of desc.descs || []) { const r = findDescTag(d, tag); if (r) return r; }
  return null;
}

export function describeTracks(mp4, info, moovBytes) {
  const res = { duration: info.duration / info.timescale, video: null, audio: null };
  const vt = info.videoTracks[0];
  if (vt) {
    const trak = mp4.getTrackById(vt.id);
    const ed = editInfo(trak, vt, info.timescale);
    const samples = trak.samples;
    const bytes = samples.reduce((a, s) => a + s.size, 0);
    const dur = vt.duration / vt.timescale || res.duration;
    res.video = {
      id: vt.id, codec: vt.codec, timescale: vt.timescale,
      codedWidth: vt.video.width, codedHeight: vt.video.height,
      rotation: rotationOf(trak), description: codecDescription(trak),
      samples, ...ed, fps: samples.length / (dur || 1), bitrate: bytes * 8 / (dur || 1), duration: dur,
    };
  }
  const at = info.audioTracks[0];
  if (at) {
    const trak = mp4.getTrackById(at.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const ed = editInfo(trak, at, info.timescale);
    let description, codec = at.codec;
    const dsi = findDescTag(entry.esds?.esd, 5);
    if (dsi?.data) description = new Uint8Array(dsi.data);
    if (!description && moovBytes && entry.start != null) {
      const raw = parseEsdsBytes(moovBytes.subarray(entry.start, entry.start + entry.size));
      if (raw) { description = raw.description; if (!/^mp4a\.40\./.test(codec)) codec = raw.codec; }
    }
    res.audio = {
      id: at.id, codec, timescale: at.timescale,
      sampleRate: at.audio.sample_rate, numberOfChannels: at.audio.channel_count,
      description, samples: trak.samples, ...ed,
    };
  }
  return res;
}

/** ファイルの一部をまとめて読むキャッシュ付きリーダー */
export class RangeReader {
  constructor(file, windowSize = 8 << 20) { this.file = file; this.win = windowSize; this.buf = null; this.start = 0; }
  async read(offset, size) {
    if (this.buf && offset >= this.start && offset + size <= this.start + this.buf.byteLength) {
      return this.buf.subarray(offset - this.start, offset - this.start + size);
    }
    const end = Math.min(this.file.size, offset + Math.max(size, this.win));
    this.buf = new Uint8Array(await this.file.slice(offset, end).arrayBuffer());
    this.start = offset;
    return this.buf.subarray(0, size);
  }
}
