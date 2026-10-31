// 字幕焼き込み書き出し（WebCodecs + mp4-muxer）
//
// ・映像: 元動画を VideoDecoder でデコード → Canvas に字幕を合成 → VideoEncoder(H.264) で再エンコード
//         各フレームのタイムスタンプは元動画の表示時刻をそのまま使う（可変フレームレートでもズレない）
// ・音声: AAC は再エンコードせず、元のサンプルをタイムスタンプごとコピー（音質劣化・音ズレなし）
//         AAC 以外は decodeAudioData → AudioEncoder(AAC) で変換
// ・ブラウザが元動画のコーデックをデコードできない場合は <video> の実時間再生からフレームを取得する
/* global Mp4Muxer */
import { readMovie, describeTracks, RangeReader } from './demux.js';
import { activeCueAt } from './cues.js';
import { rasterizeCue, drawCueRaster, animState } from './subtitle.js';

class Aborted extends Error { constructor() { super('書き出しを中止しました'); this.name = 'AbortError'; } }
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// H.264 レベル（MaxFS, MaxMBPS）
const AVC_LEVELS = [
  ['1f', 3600, 108000], ['20', 5120, 216000], ['28', 8192, 245760], ['2a', 8704, 522240],
  ['32', 22080, 589824], ['33', 36864, 983040], ['34', 36864, 2073600], ['3c', 139264, 4177920], ['3e', 139264, 16711680],
];

async function pickEncoderConfig(w, h, fps, bitrate) {
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = fs * fps;
  const cands = [];
  for (const [lv, maxFs, maxMbps] of AVC_LEVELS) if (fs <= maxFs && mbps <= maxMbps) cands.push(lv);
  if (!cands.length) cands.push('34', '3c');
  for (const profile of ['6400', '4d00', '4200']) {
    for (const lv of cands) {
      const cfg = {
        codec: `avc1.${profile}${lv}`, width: w, height: h, bitrate: Math.round(bitrate),
        framerate: Math.min(240, Math.max(1, fps)), latencyMode: 'quality', bitrateMode: 'variable', avc: { format: 'avc' },
      };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* 次の候補 */ }
    }
  }
  throw new Error(`この環境では ${w}×${h} の H.264 エンコードがサポートされていません`);
}

/** 元動画の音声をAAC/AACコピー可能なチャンク列として準備する */
async function prepareAudio(file, A, log) {
  if (!A) return null;
  const isAac = /^mp4a\.40\./.test(A.codec) && A.description;
  if (isAac) {
    return { mode: 'copy', codec: 'aac', sampleRate: A.sampleRate, numberOfChannels: A.numberOfChannels, description: A.description, A };
  }
  if (typeof AudioEncoder === 'undefined') throw new Error(`音声コーデック ${A.codec} はこのブラウザでは変換できません（AAC 音声の動画を使うか、パソコンの Chrome で書き出してください）`);
  log?.(`音声コーデック ${A.codec} は AAC に変換します`);
  const ac = new OfflineAudioContext(2, 1, 48000);
  const buf = await ac.decodeAudioData(await file.arrayBuffer());
  const chunks = [];
  let meta = null;
  const enc = new AudioEncoder({ output: (c, m) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); chunks.push({ data: d, ts: c.timestamp, dur: c.duration || 0 }); if (m?.decoderConfig) meta = m.decoderConfig; }, error: e => { throw e; } });
  const ch = Math.min(2, buf.numberOfChannels);
  enc.configure({ codec: 'mp4a.40.2', sampleRate: buf.sampleRate, numberOfChannels: ch, bitrate: 192000 });
  const N = 1024 * 16;
  for (let i = 0; i < buf.length; i += N) {
    const n = Math.min(N, buf.length - i);
    const data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(buf.getChannelData(c).subarray(i, i + n), c * n);
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: buf.sampleRate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(i / buf.sampleRate * 1e6), data }));
    if (enc.encodeQueueSize > 20) await tick(1);
  }
  await enc.flush();
  enc.close();
  return { mode: 'encoded', codec: 'aac', sampleRate: buf.sampleRate, numberOfChannels: ch, description: meta?.description ? new Uint8Array(meta.description) : undefined, chunks };
}

/** 音声チャンクを順にミュクサーへ流す（映像の進行に合わせてインターリーブ） */
function audioPump(file, audio, muxer, offsetUs, endRelUs = Infinity) {
  if (!audio) return { pump: async () => {}, firstTs: null };
  const meta = { decoderConfig: { codec: 'mp4a.40.2', sampleRate: audio.sampleRate, numberOfChannels: audio.numberOfChannels, description: audio.description } };
  let sent = false, i = 0, lastTs = -1;
  const add = (data, ts, dur) => {
    ts = Math.max(ts, lastTs + 1);
    muxer.addAudioChunkRaw(data, 'key', ts, dur, sent ? undefined : meta);
    sent = true; lastTs = ts;
  };
  if (audio.mode === 'encoded') {
    const list = audio.chunks;
    return {
      pump: async (untilUs) => {
        while (i < list.length && list[i].ts - offsetUs <= untilUs) {
          const c = list[i++];
          if (c.ts - offsetUs >= endRelUs) { i = list.length; break; } // 範囲の終わり
          if (c.ts + c.dur - offsetUs <= 0) continue; // 範囲の開始より前
          add(c.data, Math.max(0, c.ts - offsetUs), c.dur);
        }
      },
    };
  }
  const A = audio.A, reader = new RangeReader(file, 2 << 20);
  const S = A.samples;
  return {
    pump: async (untilUs) => {
      while (i < S.length) {
        const s = S[i];
        const tsSec = s.cts / A.timescale - A.mediaStart + A.delay, durSec = s.duration / A.timescale;
        const ts = Math.round(tsSec * 1e6) - offsetUs;
        if (ts > untilUs) break;
        if (ts >= endRelUs) { i = S.length; break; } // 範囲の終わり
        i++;
        if (Math.round((tsSec + durSec) * 1e6) - offsetUs <= 0) continue; // エディットリストで切り捨てられるプライミング部分・範囲の開始より前
        add(await reader.read(s.offset, s.size), Math.max(0, ts), Math.round(durSec * 1e6));
      }
    },
  };
}

/** 元音声の最初の表示時刻（エディットリスト適用後、0未満は0に丸め）[µs] */
function firstAudioUs(audio) {
  if (!audio) return null;
  if (audio.mode === 'encoded') return 0;
  const A = audio.A;
  for (const s of A.samples) {
    const t = s.cts / A.timescale - A.mediaStart + A.delay, d = s.duration / A.timescale;
    if (t + d > 1e-6) return Math.max(0, Math.round(t * 1e6));
  }
  return 0;
}

/**
 * 範囲書き出しの開始位置を、音声フレームの境目に合わせる（音声をコピーしても映像とずれないように）。
 * 指定時刻以降で最初の音声フレームの開始 [µs]。音声が無ければ指定時刻のまま。
 */
function snapStartUs(audio, startUs) {
  if (!audio) return startUs;
  if (audio.mode === 'encoded') return audio.chunks.find(c => c.ts >= startUs - 1)?.ts ?? startUs;
  const A = audio.A;
  for (const s of A.samples) {
    const t = Math.round((s.cts / A.timescale - A.mediaStart + A.delay) * 1e6);
    if (t >= startUs - 1) return t;
  }
  return startUs;
}

/**
 * 動画を書き出す
 * @param {object} o
 *  file, cues, style, fontCss, fontFamily, quality('high'|'standard'|'light'),
 *  writable (FileSystemWritableFileStream | null), onProgress({phase, ratio, fps, eta, msg}), signal,
 *  range ({start, end} 秒・元動画の時刻。省略時は動画全体。セクションごとの書き出しに使う)
 * @returns {Promise<{blob?:Blob, width, height, frames, durationSec, codec, audioMode}>}
 */
export async function exportVideo(o) {
  const { file, cues, style, onProgress = () => {}, signal } = o;
  const check = () => { if (signal?.aborted) throw new Aborted(); };
  const log = msg => onProgress({ phase: 'log', msg });
  onProgress({ phase: 'prep', ratio: 0, msg: '動画を解析中…' });
  const { mp4, info, moovBytes } = await readMovie(file);
  const T = describeTracks(mp4, info, moovBytes);
  const V = T.video;
  if (!V) throw new Error('映像トラックが見つかりません');
  const rot = V.rotation;
  const swap = rot === 90 || rot === 270;
  const dispW = swap ? V.codedHeight : V.codedWidth, dispH = swap ? V.codedWidth : V.codedHeight;
  const outW = dispW & ~1, outH = dispH & ~1;

  const decCfg = { codec: V.codec, codedWidth: V.codedWidth, codedHeight: V.codedHeight, description: V.description };
  let canDecode = false;
  try { canDecode = (await VideoDecoder.isConfigSupported(decCfg)).supported; } catch { canDecode = false; }
  if (o.forceRealtime) canDecode = false;
  log(`入力: ${V.codec} ${V.codedWidth}×${V.codedHeight} 回転${rot}° ${V.fps.toFixed(2)}fps / 音声: ${T.audio ? T.audio.codec : 'なし'}`);

  const q = { high: 1.35, standard: 1, light: 0.6 }[o.quality || 'standard'];
  const codecFactor = /^(hvc1|hev1|av01|vp09)/.test(V.codec) ? 1.6 : 1.15;
  const bitrate = Math.min(60e6, Math.max(1.5e6, V.bitrate * codecFactor * q, outW * outH * V.fps * 0.06 * q));
  const encCfg = await pickEncoderConfig(outW, outH, V.fps, bitrate);
  log(`出力: ${encCfg.codec} ${outW}×${outH} ${(bitrate / 1e6).toFixed(1)}Mbps / ${canDecode ? 'WebCodecs デコード' : '実時間キャプチャ（このコーデックはデコード非対応のため）'}`);
  check();

  // 字幕を実解像度でラスタライズ（1行1回）
  const rasters = new Map();
  for (let i = 0; i < cues.length; i++) {
    check();
    onProgress({ phase: 'prep', ratio: i / Math.max(1, cues.length), msg: `字幕を描画中… (${i + 1}/${cues.length})` });
    if (!rasters.has(cues[i].lineId)) rasters.set(cues[i].lineId, await rasterizeCue(cues[i].text, style, outW, outH, o.fontCss || '', o.fontFamily));
  }

  onProgress({ phase: 'prep', ratio: 1, msg: '音声を準備中…' });
  const audio = await prepareAudio(file, T.audio, log);
  check();
  const range = o.range && o.range.end > o.range.start ? o.range : null;
  // 出力の 0 秒 = 元動画の offsetUs。範囲書き出しでは範囲の開始（音声フレームの境目に合わせる）
  const offsetUs = range ? snapStartUs(audio, Math.round(range.start * 1e6)) : audio ? firstAudioUs(audio) : 0;
  const endRelUs = range && isFinite(range.end) ? Math.round(range.end * 1e6) - offsetUs : Infinity;
  if (range) log(`範囲: ${(offsetUs / 1e6).toFixed(3)} 秒 〜 ${isFinite(range.end) ? range.end.toFixed(3) : '最後'} 秒`);

  const target = o.writable ? new Mp4Muxer.FileSystemWritableFileStreamTarget(o.writable) : new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: 'avc', width: outW, height: outH },
    audio: audio ? { codec: 'aac', numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate } : undefined,
    fastStart: o.writable ? false : 'in-memory',
    firstTimestampBehavior: 'strict',
  });
  const ap = audioPump(file, audio, muxer, offsetUs, endRelUs);

  // ---- 合成と映像エンコード ----
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d', { alpha: false });
  let encErr = null, lastOutUs = -1, lastKeyUs = -Infinity, frames = 0, firstEmitted = false, held = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encErr = e; } },
    error: e => { encErr = e; },
  });
  encoder.configure(encCfg);

  const srcRot = canDecode ? rot : 0; // <video> 経由のフレームは回転適用済み
  const compose = (source, srcSec) => {
    const rot = srcRot, swap = rot === 90 || rot === 270;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, outH);
    if (rot === 90) { ctx.translate(outW, 0); ctx.rotate(Math.PI / 2); }
    else if (rot === 180) { ctx.translate(outW, outH); ctx.rotate(Math.PI); }
    else if (rot === 270) { ctx.translate(0, outH); ctx.rotate(-Math.PI / 2); }
    ctx.drawImage(source, 0, 0, swap ? outH : outW, swap ? outW : outH);
    ctx.restore();
    const cue = activeCueAt(cues, srcSec);
    if (cue) {
      const r = rasters.get(cue.lineId);
      if (r) drawCueRaster(ctx, r, animState(srcSec, cue.start, cue.end, style), style, outW, outH);
    }
  };
  const emit = (source, srcUs, outUs, durUs) => {
    if (outUs <= lastOutUs) outUs = lastOutUs + 1;
    compose(source, srcUs / 1e6);
    const vf = new VideoFrame(canvas, { timestamp: outUs, duration: durUs || undefined });
    const key = !firstEmitted || outUs - lastKeyUs >= 2e6;
    if (key) lastKeyUs = outUs;
    encoder.encode(vf, { keyFrame: key });
    vf.close();
    firstEmitted = true; lastOutUs = outUs; frames++;
  };
  // 0 より前（エディットリストで隠れる部分）は最後の1枚だけ保持し、0 の位置に出す
  const onFrame = (source, srcUs, durUs, release) => {
    const outUs = srcUs - offsetUs;
    if (outUs >= endRelUs) { release(); return; } // 範囲の終わりより後
    if (!firstEmitted && outUs < 0) { held?.release(); held = { source, srcUs, durUs, release }; return; }
    if (!firstEmitted && held) {
      if (outUs > 0) emit(held.source, held.srcUs, 0, outUs);
      held.release(); held = null;
    }
    emit(source, srcUs, firstEmitted ? outUs : 0, durUs);
    release();
  };

  const totalDur = range ? Math.min(V.duration || T.duration || Infinity, endRelUs / 1e6 + offsetUs / 1e6) - offsetUs / 1e6 : V.duration || T.duration;
  const t0 = performance.now();
  const report = (curSec) => {
    const el = (performance.now() - t0) / 1000;
    const ratio = Math.min(1, curSec / totalDur);
    onProgress({ phase: 'encode', ratio, fps: frames / Math.max(0.001, el), eta: ratio > 0.01 ? el / ratio - el : null, msg: `書き出し中… ${frames} フレーム` });
  };
  const waitQueues = async (dec) => {
    while ((dec && dec.decodeQueueSize > 4) || encoder.encodeQueueSize > 4) {
      if (encErr) throw encErr;
      await tick(1);
    }
  };

  try {
    if (canDecode) {
      let decErr = null;
      const decoder = new VideoDecoder({
        output: f => { try { onFrame(f, f.timestamp, f.duration, () => f.close()); } catch (e) { encErr = e; f.close(); } },
        error: e => { decErr = e; },
      });
      decoder.configure(decCfg);
      const reader = new RangeReader(file);
      const S = V.samples;
      const tsOf = s => Math.round((s.cts / V.timescale - V.mediaStart + V.delay) * 1e6);
      // 範囲書き出し：範囲の開始以前で最後のキーフレームからデコードを始める
      let first = 0;
      if (range) S.forEach((s, k) => { if (s.is_sync && tsOf(s) <= offsetUs) first = k; });
      let started = false, n = 0;
      for (let k = first; k < S.length; k++) {
        const s = S[k];
        check();
        if (decErr) throw decErr;
        if (encErr) throw encErr;
        if (!started && !s.is_sync) continue;
        started = true;
        const tsUs = tsOf(s);
        if (tsUs - offsetUs > endRelUs + 2e6) break; // 範囲の終わりを過ぎた（Bフレームの並べ替え分の余裕を見て止める）
        decoder.decode(new EncodedVideoChunk({ type: s.is_sync ? 'key' : 'delta', timestamp: tsUs, duration: Math.round(s.duration / V.timescale * 1e6), data: await reader.read(s.offset, s.size) }));
        await waitQueues(decoder);
        await ap.pump(lastOutUs + 500000);
        if (++n % 10 === 0) report(lastOutUs / 1e6);
      }
      await decoder.flush();
      decoder.close();
      if (decErr) throw decErr;
    } else {
      await captureRealtime(file, o, onFrame, () => { check(); if (encErr) throw encErr; }, async () => { await ap.pump(lastOutUs + 500000); report(lastOutUs / 1e6); }, totalDur, range ? { startSec: offsetUs / 1e6, endSec: (offsetUs + endRelUs) / 1e6 } : null);
    }
    if (held) { emit(held.source, held.srcUs, 0, held.durUs); held.release(); held = null; }
    await encoder.flush();
    if (encErr) throw encErr;
    encoder.close();
    await ap.pump(Infinity);
    onProgress({ phase: 'finalize', ratio: 1, msg: 'MP4を書き込み中…' });
    muxer.finalize();
    if (o.writable) await o.writable.close();
  } catch (e) {
    try { encoder.close(); } catch { /* closed */ }
    held?.release();
    if (o.writable) { try { await o.writable.abort(); } catch { /* ignore */ } }
    throw e;
  }
  const blob = o.writable ? null : new Blob([target.buffer], { type: 'video/mp4' });
  return { blob, width: outW, height: outH, frames, durationSec: lastOutUs / 1e6, codec: encCfg.codec, audioMode: audio?.mode || 'none', elapsed: (performance.now() - t0) / 1000 };
}

/** デコーダ非対応コーデック用：<video> を等速再生してフレームを取得（タイムスタンプは mediaTime を使用） */
async function captureRealtime(file, o, onFrame, check, onStep, totalDur, range) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:-10000px;width:16px;height:16px;';
  document.body.appendChild(v);
  const url = URL.createObjectURL(file);
  v.src = url;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('動画を再生できません')); });
    v.currentTime = range ? Math.max(0, range.startSec - 0.1) : 0;
    await new Promise(r => { v.onseeked = r; });
    let done = false, err = null, lastMedia = -1;
    const onVf = (now, meta) => {
      if (done) return;
      try {
        check();
        if (range && meta.mediaTime >= range.endSec) { done = true; v.pause(); return; }
        if (meta.mediaTime > lastMedia) {
          lastMedia = meta.mediaTime;
          onFrame(v, Math.round(meta.mediaTime * 1e6), 0, () => {});
          onStep();
        }
      } catch (e) { err = e; done = true; v.pause(); return; }
      v.requestVideoFrameCallback(onVf);
    };
    v.requestVideoFrameCallback(onVf);
    await v.play();
    await new Promise(r => { v.onended = r; const iv = setInterval(() => { if (done) { clearInterval(iv); r(); } }, 100); });
    done = true;
    if (err) throw err;
  } finally {
    v.pause(); v.removeAttribute('src'); v.load(); v.remove(); URL.revokeObjectURL(url);
  }
}
