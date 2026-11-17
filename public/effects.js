'use strict';
// Video effects: background blur, privacy blur, and virtual backgrounds.
//
// Everything runs locally in the browser. The camera frames are segmented with
// MediaPipe's selfie segmenter (served from this origin), composited on a
// canvas, and the canvas is sent as the outgoing video track. Uploaded
// background images never leave the device.

const SEG_WIDTH = 256; // segmentation input width; small is fast and plenty for a mask

// ---------- built-in backgrounds, drawn procedurally (no image files) ----------

const PRESETS = {
  gradient: { label: 'Soft gradient', draw(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#c9d6ff'); g.addColorStop(1, '#e2e2e2');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  } },
  sunset: { label: 'Sunset', draw(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2b1055'); g.addColorStop(0.55, '#d6476b'); g.addColorStop(0.75, '#f7a35c'); g.addColorStop(1, '#3b2a4a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,220,150,.9)';
    ctx.beginPath(); ctx.arc(w * 0.7, h * 0.68, h * 0.12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2a1f3d';
    ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 8) ctx.lineTo(x, h * (0.78 + 0.06 * Math.sin(x / w * 9)));
    ctx.lineTo(w, h); ctx.fill();
  } },
  night: { label: 'Night sky', draw(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0b1026'); g.addColorStop(1, '#1d2b53');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 220; i++) {
      ctx.globalAlpha = 0.3 + rnd() * 0.7;
      ctx.fillRect(rnd() * w, rnd() * h * 0.85, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    ctx.globalAlpha = 1;
  } },
  office: { label: 'Office', draw(ctx, w, h) {
    ctx.fillStyle = '#e9e4dc'; ctx.fillRect(0, 0, w, h);                  // wall
    ctx.fillStyle = '#bcd7ea'; ctx.fillRect(w * 0.08, h * 0.12, w * 0.34, h * 0.5); // window
    ctx.strokeStyle = '#fff'; ctx.lineWidth = h * 0.015;
    ctx.strokeRect(w * 0.08, h * 0.12, w * 0.34, h * 0.5);
    ctx.beginPath(); ctx.moveTo(w * 0.25, h * 0.12); ctx.lineTo(w * 0.25, h * 0.62); ctx.stroke();
    ctx.fillStyle = '#8b6b4e';                                            // shelf
    ctx.fillRect(w * 0.62, h * 0.3, w * 0.3, h * 0.025);
    ctx.fillRect(w * 0.62, h * 0.5, w * 0.3, h * 0.025);
    const books = ['#c0392b', '#2e86c1', '#27ae60', '#f1c40f', '#8e44ad', '#d35400'];
    books.forEach((c, i) => {
      ctx.fillStyle = c; ctx.fillRect(w * (0.64 + i * 0.035), h * (0.2 + (i % 2) * 0.02), w * 0.028, h * (0.1 - (i % 2) * 0.02));
    });
    ctx.fillStyle = '#3f8f4f';                                            // plant
    ctx.beginPath(); ctx.ellipse(w * 0.72, h * 0.42, w * 0.03, h * 0.07, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#d8d0c4'; ctx.fillRect(0, h * 0.82, w, h * 0.18);   // floor
  } },
};

function renderPreset(id, w = 1280, h = 720) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  PRESETS[id].draw(c.getContext('2d'), w, h);
  return c;
}

function drawCover(ctx, img, w, h) {
  const iw = img.width, ih = img.height;
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s, dh = ih * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// Timer that keeps running at full rate in background tabs (main-thread timers
// are throttled to ~1/s there, which would freeze the outgoing video).
function workerTicker(fps, onTick) {
  const src = `let t=setInterval(()=>postMessage(Date.now()),${Math.round(1000 / fps)});onmessage=()=>clearInterval(t);`;
  try {
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    // If a frame took longer than the interval, ticks queue up; skip stale
    // ones so a slow device drops frames instead of freezing the page.
    w.onmessage = (e) => { if (Date.now() - e.data < 1000 / fps) onTick(); };
    return () => w.terminate();
  } catch {
    const t = setInterval(onTick, 1000 / fps);
    return () => clearInterval(t);
  }
}

class VideoEffects {
  constructor(cameraTrack) {
    this.cameraTrack = cameraTrack;
    this.effect = { type: 'none' };
    this.segmenter = null;
    this.segmenterPromise = null;
    this.outputTrack = null;
  }

  static presets() {
    return Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label }));
  }

  static presetThumbnail(id) {
    return renderPreset(id, 160, 90);
  }

  /** Effects that need person segmentation. */
  static needsSegmentation(type) {
    return type === 'blur' || type === 'blur-strong' || type === 'image';
  }

  loadSegmenter() {
    if (!this.segmenterPromise) {
      this.segmenterPromise = (async () => {
        const { FilesetResolver, ImageSegmenter } = await import('/vendor/tasks-vision/vision_bundle.mjs');
        const fileset = await FilesetResolver.forVisionTasks('/vendor/tasks-vision/wasm');
        const make = (delegate) => ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: '/models/selfie_segmenter.tflite', delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
        // CPU is the default: the model is tiny at this input size, and the GPU
        // path pays for a GPU->CPU readback of the mask on every frame.
        try {
          this.segmenter = await make('CPU');
        } catch {
          this.segmenter = await make('GPU');
        }
        return this.segmenter;
      })();
      this.segmenterPromise.catch(() => (this.segmenterPromise = null)); // allow retry
    }
    return this.segmenterPromise;
  }

  /**
   * Switch effect. Returns the video track to send: the raw camera track for
   * 'none', otherwise the processed canvas track.
   * effect: { type: 'none'|'blur'|'blur-strong'|'privacy'|'image', image?: CanvasImageSource }
   */
  async setEffect(effect) {
    if (VideoEffects.needsSegmentation(effect.type)) await this.loadSegmenter();
    this.effect = effect;
    if (effect.type === 'none') {
      this.stopPipeline();
      return this.cameraTrack;
    }
    this.startPipeline();
    return this.outputTrack;
  }

  startPipeline() {
    if (this.outputTrack) return;
    const s = this.cameraTrack.getSettings();
    const W = (this.W = s.width || 640);
    const H = (this.H = s.height || 480);
    const segH = Math.round((SEG_WIDTH * H) / W);

    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.srcObject = new MediaStream([this.cameraTrack]);
    this.video.play().catch(() => {});

    const mk = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
    this.out = mk(W, H);
    this.person = mk(W, H);
    this.small = mk(SEG_WIDTH, segH);   // segmentation input
    this.mask = mk(SEG_WIDTH, segH);    // person alpha mask
    this.tiny = mk(Math.max(8, W >> 4), Math.max(6, H >> 4)); // fallback blur
    this.maskData = new ImageData(SEG_WIDTH, segH);
    this.ctx = this.out.getContext('2d');
    this.pctx = this.person.getContext('2d');
    this.sctx = this.small.getContext('2d', { willReadFrequently: true });
    this.mctx = this.mask.getContext('2d');
    this.hasFilter = typeof this.ctx.filter === 'string';

    this.ctx.fillRect(0, 0, W, H);
    this.outputTrack = this.out.captureStream(30).getVideoTracks()[0];
    this.outputTrack.enabled = this.cameraTrack.enabled;
    this.lastTs = 0;
    this.stopTicker = workerTicker(30, () => this.frame());
  }

  stopPipeline() {
    if (!this.outputTrack) return;
    this.stopTicker();
    this.outputTrack.stop();
    this.outputTrack = null;
    this.video.srcObject = null;
  }

  stop() {
    this.stopPipeline();
    if (this.segmenter) this.segmenter.close();
    this.segmenter = null;
  }

  blurInto(ctx, radius) {
    const { W, H, video } = this;
    if (this.hasFilter) {
      ctx.filter = `blur(${radius}px)`;
      // Overdraw slightly so the blur doesn't fade at the edges.
      ctx.drawImage(video, -radius, -radius, W + 2 * radius, H + 2 * radius);
      ctx.filter = 'none';
    } else {
      // Browsers without canvas filters: downscale then upscale with smoothing.
      const t = this.tiny.getContext('2d');
      t.drawImage(video, 0, 0, this.tiny.width, this.tiny.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.tiny, 0, 0, W, H);
    }
  }

  frame() {
    const t0 = performance.now();
    this.render();
    this.frameMs = 0.9 * (this.frameMs || 0) + 0.1 * (performance.now() - t0); // for diagnostics
  }

  render() {
    const { video, ctx, W, H, effect } = this;
    if (!this.outputTrack || video.readyState < 2) return;

    if (effect.type === 'privacy') {
      this.blurInto(ctx, Math.round(W / 25));
      return;
    }

    // Person mask from the segmenter.
    if (this.segmenter) {
      this.sctx.drawImage(video, 0, 0, this.small.width, this.small.height);
      const ts = Math.max(performance.now(), this.lastTs + 1);
      this.lastTs = ts;
      this.segmenter.segmentForVideo(this.small, ts, (result) => {
        const m = result.confidenceMasks && result.confidenceMasks[0];
        if (!m) return;
        const conf = m.getAsFloat32Array();
        const px = this.maskData.data;
        for (let i = 0; i < conf.length; i++) {
          // Soft threshold: <0.25 background, >0.75 person, smooth in between.
          const a = Math.min(1, Math.max(0, (conf[i] - 0.25) * 2));
          px[i * 4 + 3] = a * 255;
        }
        this.mctx.putImageData(this.maskData, 0, 0);
      });
    }

    // Background layer.
    if (effect.type === 'image' && effect.image) {
      drawCover(ctx, effect.image, W, H);
    } else {
      this.blurInto(ctx, effect.type === 'blur-strong' ? Math.round(W / 40) : Math.round(W / 110));
    }

    // Person layer: soft-edged mask, then the camera frame clipped to it.
    const p = this.pctx;
    p.globalCompositeOperation = 'copy';
    p.imageSmoothingEnabled = true;
    if (this.hasFilter) p.filter = 'blur(3px)';
    p.drawImage(this.mask, 0, 0, W, H);
    p.filter = 'none';
    p.globalCompositeOperation = 'source-in';
    p.drawImage(video, 0, 0, W, H);
    ctx.drawImage(this.person, 0, 0);
  }
}

window.VideoEffects = VideoEffects;
window.renderEffectPreset = renderPreset;
