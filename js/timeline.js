// タイムライン（ルーラー・波形・歌詞ごとの表示区間ブロック）
import { escapeHtml, fmtTime } from './util.js';

export class Timeline {
  constructor(opts) {
    Object.assign(this, opts); // el, inner, ruler, wave, cuesEl, playhead, callbacks
    this.pps = 80;
    this.duration = 0;
    this.cues = [];
    this.selectedId = null;
    this.activeId = null;
    this.peaks = null;
    this.drag = null;
    this.follow = true;
    this.el.addEventListener('scroll', () => this.drawCanvases());
    new ResizeObserver(() => this.layout()).observe(this.el);
    this.el.addEventListener('pointerdown', e => this.onPointerDown(e));
    window.addEventListener('pointermove', e => this.onPointerMove(e));
    window.addEventListener('pointerup', e => this.onPointerUp(e));
    // タッチでスワイプしてスクロールが始まった場合などはドラッグを取り消す
    window.addEventListener('pointercancel', () => { this.drag = null; });
    this.el.addEventListener('wheel', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const x = e.clientX - this.el.getBoundingClientRect().left + this.el.scrollLeft;
      const t = x / this.pps;
      this.setZoom(this.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      this.el.scrollLeft = t * this.pps - (e.clientX - this.el.getBoundingClientRect().left);
      this.onZoom?.(this.pps);
    }, { passive: false });
  }

  setZoom(pps) { this.pps = Math.max(5, Math.min(600, pps)); this.layout(); this.render(); }
  setDuration(d) { this.duration = d || 0; this.layout(); this.render(); }
  setPeaks(peaks, perSec) { this.peaks = peaks; this.peaksPerSec = perSec; this.drawCanvases(); }

  layout() {
    const w = Math.max(this.el.clientWidth, Math.ceil(this.duration * this.pps) + 60);
    this.inner.style.width = `${w}px`;
    this.drawCanvases();
  }

  drawCanvases() {
    const vw = this.el.clientWidth, sl = this.el.scrollLeft, dpr = devicePixelRatio || 1;
    for (const c of [this.ruler, this.wave]) {
      c.style.left = `${sl}px`;
      c.style.width = `${vw}px`;
      c.width = Math.round(vw * dpr);
      c.height = Math.round(c.clientHeight * dpr);
    }
    // ルーラー
    let ctx = this.ruler.getContext('2d');
    ctx.scale(dpr, dpr);
    const h = this.ruler.clientHeight;
    ctx.fillStyle = '#1d2029'; ctx.fillRect(0, 0, vw, h);
    const steps = [0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const major = steps.find(s => s * this.pps >= 70) || 300;
    const minor = major / (major >= 10 ? 5 : major >= 1 ? (major === 2 ? 4 : 5) : 5);
    const t0 = sl / this.pps, t1 = (sl + vw) / this.pps;
    ctx.strokeStyle = '#444a5e'; ctx.fillStyle = '#8d93a6'; ctx.font = '10px ui-monospace, Menlo, monospace';
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(t * this.pps - sl) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(x, h); ctx.lineTo(x, isMajor ? 6 : h - 5);
      if (isMajor) ctx.fillText(fmtTime(t, major < 1), x + 3, 11);
    }
    ctx.stroke();
    // 波形
    ctx = this.wave.getContext('2d');
    ctx.scale(dpr, dpr);
    const wh = this.wave.clientHeight;
    ctx.clearRect(0, 0, vw, wh);
    if (this.peaks) {
      ctx.fillStyle = '#3c5a8a';
      const mid = wh / 2;
      for (let x = 0; x < vw; x++) {
        const a = Math.floor((sl + x) / this.pps * this.peaksPerSec), b = Math.max(a + 1, Math.floor((sl + x + 1) / this.pps * this.peaksPerSec));
        let m = 0;
        for (let i = a; i < b && i < this.peaks.length; i++) if (this.peaks[i] > m) m = this.peaks[i];
        const hh = Math.max(0.5, m * (wh / 2 - 1));
        ctx.fillRect(x, mid - hh, 1, hh * 2);
      }
    } else {
      ctx.fillStyle = '#5a6078'; ctx.font = '11px sans-serif';
      ctx.fillText(this.waveMsg || '', 8, wh / 2 + 4);
    }
  }

  /** cues: buildCues() の結果 */
  setCues(cues) { this.cues = cues; this.render(); }

  render() {
    const pps = this.pps, total = this.duration || 0;
    const html = this.cues.map((c, i) => {
      const end = isFinite(c.end) ? c.end : total;
      const left = c.start * pps, width = Math.max(4, (end - c.start) * pps);
      const cls = ['tl-cue', c.explicitEnd == null ? 'auto-end' : '', c.lineId === this.selectedId ? 'sel' : '', c.lineId === this.activeId ? 'active' : ''].join(' ');
      return `<div class="${cls}" data-id="${c.lineId}" style="left:${left}px;width:${width}px" title="${escapeHtml(c.text)}\n${fmtTime(c.start)} → ${fmtTime(end)}"><div class="h l" data-h="l"></div><span class="n">${c.index + 1}</span>${escapeHtml(c.text)}<div class="h r" data-h="r"></div></div>`;
    }).join('');
    this.cuesEl.innerHTML = html;
  }

  setActive(id) {
    if (id === this.activeId) return;
    this.cuesEl.querySelector('.tl-cue.active')?.classList.remove('active');
    this.activeId = id;
    if (id) this.cuesEl.querySelector(`.tl-cue[data-id="${id}"]`)?.classList.add('active');
  }
  setSelected(id) {
    this.selectedId = id;
    this.cuesEl.querySelectorAll('.tl-cue.sel').forEach(e => e.classList.remove('sel'));
    if (id) this.cuesEl.querySelector(`.tl-cue[data-id="${id}"]`)?.classList.add('sel');
  }
  scrollToTime(t) {
    const x = t * this.pps;
    if (x < this.el.scrollLeft || x > this.el.scrollLeft + this.el.clientWidth - 40) this.el.scrollLeft = x - this.el.clientWidth * 0.3;
  }

  setTime(t, playing) {
    this.playhead.style.transform = `translateX(${t * this.pps}px)`;
    if (this.follow && playing && !this.drag) {
      const x = t * this.pps;
      if (x > this.el.scrollLeft + this.el.clientWidth * 0.85 || x < this.el.scrollLeft) this.el.scrollLeft = x - this.el.clientWidth * 0.3;
    }
  }

  timeAt(clientX) {
    return Math.max(0, Math.min(this.duration || 0, (clientX - this.el.getBoundingClientRect().left + this.el.scrollLeft) / this.pps));
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    const block = e.target.closest('.tl-cue');
    if (block) {
      const id = block.dataset.id;
      const cue = this.cues.find(c => c.lineId === id);
      if (!cue) return;
      const mode = e.target.dataset.h || 'move';
      this.drag = { mode, id, x0: e.clientX, start: cue.start, end: cue.end, explicitEnd: cue.explicitEnd, moved: false };
      this.onSelect?.(id, false);
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'touch') {
      // タッチは横スワイプでスクロールできるよう、指を離した時にタップならシーク
      this.drag = { mode: 'tap', x0: e.clientX };
      return;
    }
    this.drag = { mode: 'scrub' };
    this.onSeek?.(this.timeAt(e.clientX));
  }

  onPointerMove(e) {
    const d = this.drag;
    if (!d) return;
    if (d.mode === 'scrub') { this.onSeek?.(this.timeAt(e.clientX)); return; }
    if (d.mode === 'tap') return;
    const dt = (e.clientX - d.x0) / this.pps;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    if (!d.moved) { d.moved = true; this.onDragStart?.(); }
    const snap = t => {
      if (e.altKey) return t;
      const ph = this.getPlayhead?.();
      return ph != null && Math.abs(ph - t) * this.pps < 6 ? ph : t;
    };
    let start = d.start, end = d.explicitEnd;
    const minLen = 0.05;
    if (d.mode === 'move') {
      start = Math.max(0, snap(d.start + dt));
      if (d.explicitEnd != null) end = d.explicitEnd + (start - d.start);
    } else if (d.mode === 'l') {
      start = Math.max(0, Math.min(snap(d.start + dt), (isFinite(d.end) ? d.end : Infinity) - minLen));
    } else if (d.mode === 'r') {
      end = Math.max(d.start + minLen, snap((isFinite(d.end) ? d.end : this.duration) + dt));
    }
    this.onCueChange?.(d.id, { start, end });
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (d?.mode === 'tap') { if (Math.abs(e.clientX - d.x0) < 8) this.onSeek?.(this.timeAt(e.clientX)); return; }
    if (d && d.mode !== 'scrub') {
      if (d.moved) this.onDragEnd?.(d.id);
      else { this.onSelect?.(d.id, false); this.onSeek?.(this.timeAt(e.clientX)); } // クリックした位置へ再生位置を移動（分割位置の指定に使う）
    }
  }
}
