// テスト用動画ジェネレーター（WebCodecs + mp4-muxer）
// 毎秒 0.0 秒ちょうどに 1kHz のビープ音（100ms）と白フラッシュを入れた動画を作る → 書き出し後の音ズレ検証に使う
/* global Mp4Muxer */
export async function makeTestVideo({ width = 1080, height = 1920, rotation = 0, seconds = 6, fps = 30, codec = 'avc' } = {}) {
  // rotation=90 の場合は横長(coded)で作って回転メタデータを付ける（iPhone の縦動画と同じ構造）
  const cw = rotation % 180 ? height : width, ch = rotation % 180 ? width : height;
  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target, fastStart: 'in-memory',
    video: { codec, width: cw, height: ch, rotation },
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 48000 },
  });
  const ve = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { throw e; } });
  const vcodec = codec === 'hevc' ? 'hvc1.1.6.L123.B0' : (cw * ch > 2073600 ? 'avc1.640033' : 'avc1.640028');
  ve.configure({ codec: vcodec, width: cw, height: ch, bitrate: 4e6, framerate: fps, ...(codec === 'avc' ? { avc: { format: 'avc' } } : { hevc: { format: 'hevc' } }) });
  const cv = new OffscreenCanvas(cw, ch), ctx = cv.getContext('2d');
  const n = seconds * fps;
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const flash = (t % 1) < 0.1;
    ctx.save();
    // 「表示上の上」が分かるように描く（回転を逆適用）
    ctx.fillStyle = flash ? '#ffffff' : `hsl(${(t * 40) % 360},50%,30%)`;
    ctx.fillRect(0, 0, cw, ch);
    if (rotation === 90) { ctx.translate(0, ch); ctx.rotate(-Math.PI / 2); }
    const W = rotation % 180 ? ch : cw, H = rotation % 180 ? cw : ch;
    ctx.fillStyle = flash ? '#000' : '#fff';
    ctx.font = `bold ${Math.round(Math.min(W, H) / 8)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(t.toFixed(2) + 's', W / 2, H * 0.2);
    ctx.font = `${Math.round(Math.min(W, H) / 18)}px sans-serif`;
    ctx.fillText(`TOP  ${W}x${H}  frame ${i}`, W / 2, H * 0.08);
    ctx.fillRect(W * 0.05, H * 0.9, W * 0.9 * (t / seconds), H * 0.02);
    ctx.restore();
    const f = new VideoFrame(cv, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
    ve.encode(f, { keyFrame: i % fps === 0 });
    f.close();
    while (ve.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 1));
  }
  await ve.flush();
  const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { throw e; } });
  ae.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
  const sr = 48000, total = seconds * sr, block = 4800;
  for (let s = 0; s < total; s += block) {
    const data = new Float32Array(block * 2);
    for (let j = 0; j < block; j++) {
      const t = (s + j) / sr;
      const v = (t % 1) < 0.1 ? 0.6 * Math.sin(2 * Math.PI * 1000 * t) : 0;
      data[j] = v; data[block + j] = v;
    }
    ae.encode(new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: block, numberOfChannels: 2, timestamp: Math.round(s / sr * 1e6), data }));
  }
  await ae.flush();
  muxer.finalize();
  const name = `test_${width}x${height}${rotation ? '_rot' + rotation : ''}_${codec}.mp4`;
  return new File([target.buffer], name, { type: 'video/mp4', lastModified: Date.now() });
}

/** 音声のビープ開始時刻（秒）を検出 */
export async function detectBeeps(fileOrBlob) {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buf = await ctx.decodeAudioData(await fileOrBlob.arrayBuffer());
  const d = buf.getChannelData(0), sr = buf.sampleRate, res = [];
  let inBeep = false, quiet = 0;
  for (let i = 0; i < d.length; i++) {
    const a = Math.abs(d[i]);
    if (!inBeep && a > 0.2) { res.push(i / sr); inBeep = true; quiet = 0; }
    else if (inBeep) { quiet = a < 0.05 ? quiet + 1 : 0; if (quiet > sr * 0.05) inBeep = false; }
  }
  return res;
}
