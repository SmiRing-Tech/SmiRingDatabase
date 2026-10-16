import { useEffect, useRef, useState } from 'react';

/**
 * Screen-share bench: what each share setting costs this machine and what it looks like, so the
 * share's resolution / frame rate / codec / bitrate can be chosen from numbers instead of guesses.
 *
 * No server and no login: the page sends the share to itself over two local RTCPeerConnections,
 * so the sender's encoder and the receiver's decoder are both this machine's (public, like
 * /dev/blur-lab, so a slow machine's owner can just open a link). Bitrate is pinned with the
 * x-google-* SDP parameters so every row is compared at the bitrate it names, not at whatever a
 * loopback bandwidth estimate ramps to. Real-network behaviour (uplink squeezes) is what the call
 * telemetry records; this page answers "how heavy" and "how sharp".
 *
 * Source, for the text rows:
 *  - the built-in test screen: a text-heavy document at 2560x1440;
 *  - screenshots of real screens (slides, docs, sheets) the person loads — real content, still
 *    played by the same script, so every row and every machine sees exactly the same motion;
 *  - or a live screen/window via getDisplayMedia (no fixed script, so no per-phase numbers).
 * The script, 12s: still -> scroll halfway into the next page -> flip -> still. With a scripted
 * source each row is measured over exactly one cycle, split into the scroll (can the encoder keep
 * up?) and a still frame compared with the original (PSNR — how much fine text survived the
 * resolution and the compression). The video rows always use a test screen that moves every frame.
 * Keep the tab in front while it runs: hidden tabs throttle.
 *
 * Encoder/decoder names show as "?" with the test screen: Chrome only exposes them to a page that
 * holds a camera or screen-capture permission.
 */

type Codec = 'VP8' | 'VP9' | 'H264' | 'AV1';

interface ShareConfig {
  label: string;
  codec: Codec;
  /** Encoded height; 0 = the source's own size, not scaled (what Meet does). */
  height: number;
  fps: number;
  kbps: number;
  mode: 'text' | 'motion';
  /**
   * VP9/AV1 run as L1T3 (one resolution): LiveKit's default for them is L3T3_KEY (three
   * resolutions in one stream, the SFU forwards one), but without an SFU in between the receiver
   * here would get all three and its numbers would mean nothing. LiveKit can be told L1T3 too.
   */
  scalabilityMode?: string;
  /** Overrides the content hint the mode implies (LiveKit forces 'motion' on SVC screen shares). */
  hint?: 'detail' | 'motion';
}

const SUITE: ShareConfig[] = [
  { label: '現在の設定', codec: 'VP8', height: 1080, fps: 15, kbps: 4000, mode: 'text' },
  { label: 'VP8 5fps', codec: 'VP8', height: 1080, fps: 5, kbps: 4000, mode: 'text' },
  { label: 'VP8 1440p', codec: 'VP8', height: 1440, fps: 15, kbps: 4000, mode: 'text' },
  { label: 'VP8 1440p 6M', codec: 'VP8', height: 1440, fps: 15, kbps: 6000, mode: 'text' },
  { label: 'VP8 1440p 8M', codec: 'VP8', height: 1440, fps: 15, kbps: 8000, mode: 'text' },
  { label: 'VP8 720p', codec: 'VP8', height: 720, fps: 15, kbps: 2500, mode: 'text' },
  // Meet's screen share as measured in its webrtc-internals dump (M4, 2026-10-15): AV1 (libaom),
  // L1T2, the tab at its own size (1536x1096), up to ~27fps while scrolling, ~2.9Mbps allowed
  // (0.4-0.8Mbps actually used scrolling, ~17kbps still), 2-3.5ms/frame, encoder PSNR ~50dB.
  // What production would send (decided 2026-10-15: AV1, own size up to 2560x1600, max 15fps),
  // as LiveKit publishes it — it forces L1T3 and contentHint 'motion' on SVC-codec screen shares —
  // vs the same with the 'detail' hint put back.
  { label: 'AV1 原寸15（LiveKit標準）', codec: 'AV1', height: 0, fps: 15, kbps: 3000, mode: 'text', scalabilityMode: 'L1T3', hint: 'motion' },
  { label: 'AV1 原寸15（画面指定）', codec: 'AV1', height: 0, fps: 15, kbps: 3000, mode: 'text', scalabilityMode: 'L1T3', hint: 'detail' },
  // Meet's own settings (screen hint, L1T2) at production's 15fps; and LiveKit's default at 1080p.
  // On a real, moving screen (2026-10-16) LiveKit's default AV1 ran 12-40ms/frame with spikes to
  // 400ms while Meet's ran 2-3.5ms: these rows are for finding out which setting makes the gap.
  { label: 'AV1 原寸15（Meet式）', codec: 'AV1', height: 0, fps: 15, kbps: 3000, mode: 'text', scalabilityMode: 'L1T2', hint: 'detail' },
  { label: 'AV1 1080p15（LiveKit標準）', codec: 'AV1', height: 1080, fps: 15, kbps: 3000, mode: 'text', scalabilityMode: 'L1T3', hint: 'motion' },
  { label: 'AV1 原寸（Meet式）', codec: 'AV1', height: 0, fps: 30, kbps: 3000, mode: 'text', scalabilityMode: 'L1T2' },
  { label: 'AV1 1080p（Meet式）', codec: 'AV1', height: 1080, fps: 30, kbps: 3000, mode: 'text', scalabilityMode: 'L1T2' },
  { label: 'VP9 原寸（Meet式）', codec: 'VP9', height: 0, fps: 30, kbps: 3000, mode: 'text', scalabilityMode: 'L1T2' },
  { label: 'VP8 原寸', codec: 'VP8', height: 0, fps: 15, kbps: 6000, mode: 'text' },
  { label: 'H.264', codec: 'H264', height: 1080, fps: 15, kbps: 4000, mode: 'text' },
  { label: '動画 720p30', codec: 'VP8', height: 720, fps: 30, kbps: 3000, mode: 'motion' },
  { label: '動画 1080p30', codec: 'VP8', height: 1080, fps: 30, kbps: 5000, mode: 'motion' },
];

// Dropped after the first M4 run (2026-10-15): VP9 at 2Mbps and AV1 at 2Mbps (15fps, L1T3) both
// dropped frames while scrolling on the dense test screen. Back as the "Meet式" rows above once
// Meet turned out to share in AV1; H.264 stays for the slow-PC comparison.

/** The rows that matter for choosing production's share settings (the "本番の候補" filter). */
const CANDIDATES = new Set([
  '現在の設定',
  'AV1 原寸15（LiveKit標準）',
  'AV1 原寸15（画面指定）',
  'AV1 原寸15（Meet式）',
  'AV1 1080p15（LiveKit標準）',
]);

const WARMUP_MS = 4000;
/** One full cycle of the test screen: still, scroll, flip, still. */
const MEASURE_MS = 12_000;
const CYCLE_MS = 12_000;
/** Still-screen refresh, like a real screen capture's (see TestScreen.draw). */
const STILL_REFRESH_MS = 500;
const SYNTH_W = 2560;
const SYNTH_H = 1440;

interface Row {
  label: string;
  config: string;
  sent: string;
  sentFps: number;
  kbps: number;
  encodeMs: number;
  /** Encoder busy share of one core: encode ms/frame × fps / 1000. */
  encodeLoad: number;
  qp: number;
  limit: string;
  encoder: string;
  mode: string;
  decodeMs: number;
  decodedFps: number;
  freezes: number;
  decoder: string;
  /** Scripted sources only: the 4s scroll on its own, and a still frame vs the original. */
  scrollFps: number;
  scrollKbps: number;
  scrollQp: number;
  /** The still 0-4s of the cycle (still since the previous flip): what holding a sharp screen costs. */
  stillKbps: number;
  /** dB; higher = closer to the original. Received frame scaled back up to the source size. */
  psnr: number;
  pageNote?: string;
  crops?: StillCheck['crops'];
  /**
   * The encoder's own PSNR (luma, dB) at the encoded size, when Chrome reports it (psnrSum — Meet's
   * dump had it: ~50dB). Leaves out what scaling down lost; comparable with Meet's number.
   */
  encoderPsnr: number;
  error?: string;
}

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gpuName(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl!.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof name === 'string' ? name : '?';
  } catch {
    return '?';
  }
}

function codecSupported(codec: Codec) {
  const caps = RTCRtpSender.getCapabilities?.('video')?.codecs ?? [];
  return caps.some((c) => c.mimeType.toLowerCase() === `video/${codec.toLowerCase()}`);
}

// ------------------------------------------------------------------ test screen

const PARAGRAPHS = [
  '画面共有の文字がどこまで読めるかを確かめるための文章です。小さい文字、漢字の細かい線、英数字の混ざった行を並べています。',
  'The quick brown fox jumps over the lazy dog. 0123456789 — Il1| O0 rn/m: shapes that blur together first when a share is soft.',
  '会議の資料、スプレッドシートの数字、コードの細かい記号（{}[]()<>;:=+-*/）は、解像度とビットレートが足りないと最初に潰れます。',
  'const total = rows.filter((r) => r.active && r.score >= 0.75).map((r) => r.value).reduce((a, b) => a + b, 0);',
];

/** Pre-rendered pages (tall canvases), so each frame of the scroll is just one drawImage. */
function renderPage(index: number) {
  const page = document.createElement('canvas');
  page.width = SYNTH_W;
  page.height = SYNTH_H * 2;
  const g = page.getContext('2d')!;
  g.fillStyle = index % 2 ? '#f7f9fc' : '#ffffff';
  g.fillRect(0, 0, page.width, page.height);
  let y = 90;
  g.fillStyle = '#0f172a';
  g.font = 'bold 44px sans-serif';
  g.fillText(`ページ ${index + 1} — 画面共有テスト`, 80, y);
  y += 50;
  const sizes = [13, 15, 18, 24];
  for (let block = 0; y < page.height - 120; block++) {
    const size = sizes[block % sizes.length];
    const mono = block % 4 === 3;
    g.font = `${size}px ${mono ? 'monospace' : 'sans-serif'}`;
    g.fillStyle = block % 5 === 4 ? '#1d4ed8' : '#111827';
    for (let line = 0; line < 6; line++) {
      const text = `${size}px  ${PARAGRAPHS[(block + line + index) % PARAGRAPHS.length]}`;
      g.fillText(text, 80, y);
      g.fillText(text, 80 + SYNTH_W / 2, y);
      y += size * 1.6;
    }
    // A table: thin grid lines and small numbers, the classic spreadsheet case.
    if (block % 3 === 1) {
      g.strokeStyle = '#cbd5e1';
      g.lineWidth = 1;
      g.font = '14px sans-serif';
      for (let r = 0; r < 6; r++) {
        for (let c = 0; c < 12; c++) {
          g.strokeRect(80 + c * 190, y + r * 26, 190, 26);
          g.fillStyle = '#334155';
          g.fillText(String(((r + 1) * (c + 7) * (index + 3)) % 9973), 88 + c * 190, y + r * 26 + 18);
        }
      }
      y += 6 * 26 + 30;
    }
    y += 24;
  }
  return page;
}

/** Two screenshots one above the other, each fitted to w x h: a page the script can scroll down. */
function stackPages(top: ImageBitmap, bottom: ImageBitmap, w: number, h: number) {
  const page = document.createElement('canvas');
  page.width = w;
  page.height = h * 2;
  const g = page.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h * 2);
  g.drawImage(top, 0, 0, w, h);
  g.drawImage(bottom, 0, h, w, h);
  return page;
}

/**
 * 'document': the 12s script — 0-4s still, 4-8s scroll, 8s flip to the next page, 8-12s still.
 * 'video': moves every frame (drifting colour fields, a scrolling page, a ticker), standing in for
 * a shared video or animation.
 */
class TestScreen {
  readonly canvas = document.createElement('canvas');
  readonly track: MediaStreamTrack;
  /** Each page is two screens tall: the scroll runs down it. */
  private readonly pages: HTMLCanvasElement[];
  private readonly g: CanvasRenderingContext2D;
  private raf = 0;
  private start = performance.now();
  private lastKey = '';
  private lastPaint = 0;
  private readonly kind: 'document' | 'video';
  private readonly w: number;
  private readonly h: number;

  /** `images`: screenshots to play instead of the built-in document (document kind only). */
  constructor(kind: 'document' | 'video', images?: ImageBitmap[]) {
    this.kind = kind;
    if (kind === 'document' && images && images.length > 0) {
      // Screenshots keep their own shape, fitted within 2560x1600 (a Retina capture is larger).
      const scale = Math.min(1, 2560 / images[0].width, 1600 / images[0].height);
      this.w = Math.round((images[0].width * scale) / 2) * 2;
      this.h = Math.round((images[0].height * scale) / 2) * 2;
      this.pages = images.map((_, i) => stackPages(images[i], images[(i + 1) % images.length], this.w, this.h));
    } else {
      this.w = SYNTH_W;
      this.h = SYNTH_H;
      this.pages = [renderPage(0), renderPage(1), renderPage(2)];
    }
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.g = this.canvas.getContext('2d')!;
    this.track = this.canvas.captureStream(30).getVideoTracks()[0];
    const tick = () => {
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  private draw() {
    if (this.kind === 'video') {
      this.drawVideo();
      return;
    }
    const elapsed = performance.now() - this.start;
    const cycle = Math.floor(elapsed / CYCLE_MS);
    const t = elapsed % CYCLE_MS;
    const page = this.pages[(cycle + (t >= 8000 ? 1 : 0)) % this.pages.length];
    const scroll = t < 4000 ? 0 : t < 8000 ? ((t - 4000) / 4000) * this.h * 0.6 : 0;
    const key = `${cycle}:${t >= 8000}:${Math.round(scroll)}`;
    // While still, repaint the same picture twice a second, as Chrome's screen capturer does: the
    // encoder only sharpens a static screen when it's handed new frames (Meet's share ran at ~2fps,
    // ~17kbps when still). Painting nothing left every row stuck at its rough first frame after a
    // flip, which made the PSNR column meaningless (2026-10-15 run).
    const now = performance.now();
    if (key === this.lastKey && now - this.lastPaint < STILL_REFRESH_MS) return;
    this.lastKey = key;
    this.lastPaint = now;
    this.g.drawImage(page, 0, scroll, this.w, this.h, 0, 0, this.w, this.h);
  }

  /**
   * Back to the start of the script. Each row calls this, so every row's still frame is the same
   * page: without it, which page happened to be still at the PSNR moment depended on the row's
   * start time, and rows were compared on different pages (2026-10-15: a nearly blank page scored
   * 75dB at 720p).
   */
  restart() {
    this.start = performance.now();
    this.lastKey = '';
  }

  /** Where in the 12s script we are, ms. */
  phaseMs() {
    return (performance.now() - this.start) % CYCLE_MS;
  }

  get pageCount() {
    return this.pages.length;
  }

  /** Page k as it looks while still (its top screen), for checking which page was received. */
  stillView(k: number): ImageData {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(this.pages[k], 0, 0, this.w, this.h, 0, 0, this.w, this.h);
    return g.getImageData(0, 0, this.w, this.h);
  }

  private drawVideo() {
    const t = (performance.now() - this.start) / 1000;
    const g = this.g;
    g.drawImage(this.pages[0], 0, (t * 120) % SYNTH_H, SYNTH_W, SYNTH_H, 0, 0, SYNTH_W, SYNTH_H);
    for (let i = 0; i < 6; i++) {
      const x = SYNTH_W * (0.5 + 0.4 * Math.sin(t * (0.4 + i * 0.13) + i));
      const y = SYNTH_H * (0.5 + 0.4 * Math.cos(t * (0.3 + i * 0.11) + i * 2));
      const r = 260 + 120 * Math.sin(t + i);
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `hsla(${(i * 60 + t * 40) % 360}, 80%, 55%, 0.85)`);
      grad.addColorStop(1, 'hsla(0, 0%, 0%, 0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.fillStyle = '#0f172a';
    g.fillRect(0, SYNTH_H - 90, SYNTH_W, 90);
    g.fillStyle = '#f8fafc';
    g.font = 'bold 40px sans-serif';
    g.fillText(PARAGRAPHS.join('   '), SYNTH_W - ((t * 400) % (SYNTH_W * 3)), SYNTH_H - 32);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.track.stop();
  }
}

// ------------------------------------------------------------------ loopback

/** Pins the bitrate: x-google-{start,min,max}-bitrate on every payload of `codec` (kbps). */
function pinBitrate(sdp: string, codec: Codec, kbps: number) {
  const pts = [...sdp.matchAll(new RegExp(`a=rtpmap:(\\d+) ${codec}/90000`, 'gi'))].map((m) => m[1]);
  const params = `x-google-start-bitrate=${kbps};x-google-min-bitrate=${Math.round(kbps * 0.8)};x-google-max-bitrate=${kbps}`;
  let out = sdp;
  for (const pt of pts) {
    const fmtp = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
    if (fmtp.test(out)) out = out.replace(fmtp, (_m, rest: string) => `a=fmtp:${pt} ${rest};${params}`);
    else out = out.replace(new RegExp(`(a=rtpmap:${pt} [^\\r\\n]*)`), `$1\r\na=fmtp:${pt} ${params}`);
  }
  return out;
}

interface Loopback {
  sender: RTCRtpSender;
  receiver: RTCRtpReceiver;
  remoteStream: MediaStream;
  close: () => void;
}

async function openLoopback(source: MediaStreamTrack, cfg: ShareConfig): Promise<Loopback> {
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => e.candidate && void pc2.addIceCandidate(e.candidate);
  pc2.onicecandidate = (e) => e.candidate && void pc1.addIceCandidate(e.candidate);
  const track = source.clone();
  // SVC codecs get 'motion' like LiveKit gives them (its workaround, see getDefaultDegradationPreference
  // in livekit-client): with 'detail', Chrome's VP9/AV1 SVC encoder never starts (0 frames, measured).
  // degradationPreference below still keeps the resolution for text rows.
  track.contentHint = cfg.hint ?? (cfg.mode === 'text' && !cfg.scalabilityMode?.startsWith('L3') ? 'detail' : 'motion');
  const srcHeight = track.getSettings().height ?? cfg.height;
  const encoding: RTCRtpEncodingParameters & { scalabilityMode?: string } = {
    maxBitrate: cfg.kbps * 1000,
    maxFramerate: cfg.fps,
    scaleResolutionDownBy: cfg.height ? Math.max(1, srcHeight / cfg.height) : 1,
  };
  const tx = pc1.addTransceiver(track, { direction: 'sendonly', sendEncodings: [encoding] });
  const caps = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
  const wanted = caps.filter((c) => c.mimeType.toLowerCase() === `video/${cfg.codec.toLowerCase()}`);
  const rest = caps.filter((c) => /rtx|red|ulpfec/i.test(c.mimeType));
  tx.setCodecPreferences([...wanted, ...rest]);
  const remoteStream = new MediaStream();
  pc2.ontrack = (e) => remoteStream.addTrack(e.track);

  const offer = await pc1.createOffer();
  offer.sdp = pinBitrate(offer.sdp ?? '', cfg.codec, cfg.kbps);
  await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer);
  const answer = await pc2.createAnswer();
  answer.sdp = pinBitrate(answer.sdp ?? '', cfg.codec, cfg.kbps);
  await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(answer);

  // SVC only once the codec is negotiated: set at addTransceiver time it's validated against the
  // default codec (VP8, no spatial layers) and the encoding never starts.
  if (cfg.scalabilityMode) {
    const params = tx.sender.getParameters();
    (params.encodings[0] as RTCRtpEncodingParameters & { scalabilityMode?: string }).scalabilityMode = cfg.scalabilityMode;
    await tx.sender.setParameters(params);
  }
  try {
    const params = tx.sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
    params.degradationPreference = cfg.mode === 'text' ? 'maintain-resolution' : 'maintain-framerate';
    await tx.sender.setParameters(params);
  } catch {
    // Older browsers without degradationPreference: contentHint alone sets the same default.
  }
  const receiver = pc2.getReceivers().find((r) => r.track.kind === 'video')!;
  return {
    sender: tx.sender,
    receiver,
    remoteStream,
    close: () => {
      track.stop();
      pc1.close();
      pc2.close();
    },
  };
}

type Stat = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function statOf(target: RTCRtpSender | RTCRtpReceiver, type: 'outbound-rtp' | 'inbound-rtp'): Promise<Stat | undefined> {
  let found: Stat | undefined;
  (await target.getStats()).forEach((s) => {
    if (s.type === type && s.kind === 'video') found = s;
  });
  return found;
}

function describe(cfg: ShareConfig) {
  return `${cfg.codec} ${cfg.height ? `${cfg.height}p` : '原寸'} ${cfg.fps}fps ${cfg.kbps / 1000}Mbps ${cfg.mode === 'text' ? '文字' : '動画'}${
    cfg.scalabilityMode ? ` ${cfg.scalabilityMode}` : ''
  }${cfg.hint ? ` hint=${cfg.hint}` : ''}`;
}

function lumaPsnr(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let squared = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 8) {
    const ya = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const yb = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
    squared += (ya - yb) ** 2;
    n += 1;
  }
  const mse = squared / n;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

const CROP_W = 640;
const CROP_H = 360;

interface StillCheck {
  /** Received frame vs the source canvas right now, PSNR on luma (dB) at the source's size. */
  psnr: number;
  /** Set when the received frame matches another page clearly better (the comparison was misaligned). */
  pageNote?: string;
  /** The busiest 640x360 region at 1:1, source and received side by side, for looking at. */
  crops?: { src: string; recv: string; recvSize: string };
}

/** The busiest CROP_W x CROP_H cell of the source (most luma variance): where fine text is. */
function busiestCell(data: Uint8ClampedArray, w: number, h: number) {
  let best = { x: 0, y: 0, score: -1 };
  for (let y = 0; y + CROP_H <= h; y += CROP_H / 2) {
    for (let x = 0; x + CROP_W <= w; x += CROP_W / 2) {
      let sum = 0;
      let sq = 0;
      let n = 0;
      for (let yy = y; yy < y + CROP_H; yy += 6) {
        for (let xx = x; xx < x + CROP_W; xx += 6) {
          const i = (yy * w + xx) * 4;
          const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          sum += l;
          sq += l * l;
          n += 1;
        }
      }
      const variance = sq / n - (sum / n) ** 2;
      if (variance > best.score) best = { x, y, score: variance };
    }
  }
  return best;
}

function cropUrl(source: CanvasImageSource, x: number, y: number) {
  const c = document.createElement('canvas');
  c.width = CROP_W;
  c.height = CROP_H;
  c.getContext('2d')!.drawImage(source, x, y, CROP_W, CROP_H, 0, 0, CROP_W, CROP_H);
  return c.toDataURL('image/png');
}

/** Compares the received still frame with the source: PSNR, which page it matches, and crops. */
function checkStill(video: HTMLVideoElement | null, screen: TestScreen): StillCheck {
  if (!video?.videoWidth) return { psnr: NaN };
  const source = screen.canvas;
  const { width: w, height: h } = source;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(video, 0, 0, w, h);
  const received = g.getImageData(0, 0, w, h).data;
  const current = source.getContext('2d')!.getImageData(0, 0, w, h).data;
  const psnr = lumaPsnr(received, current);
  let pageNote: string | undefined;
  for (let k = 0; k < screen.pageCount; k++) {
    const other = lumaPsnr(received, screen.stillView(k).data);
    if (other > psnr + 3) pageNote = `ページ${k + 1}と一致 ${other.toFixed(1)}dB`;
  }
  const cell = busiestCell(current, w, h);
  return {
    psnr,
    pageNote,
    crops: { src: cropUrl(source, cell.x, cell.y), recv: cropUrl(c, cell.x, cell.y), recvSize: `${video.videoWidth}x${video.videoHeight}` },
  };
}

const delta = (a: Stat | undefined, b: Stat | undefined, k: string) => (b?.[k] ?? 0) - (a?.[k] ?? 0);

/**
 * With a scripted source: the script restarts, then the second cycle is measured with snapshots at
 * its phase boundaries — the scroll (4-8s) on its own, and a still frame (3.5s, still since the
 * first cycle's flip, so always the second page) compared with the original.
 * Otherwise MEASURE_MS after a warm-up.
 */
async function measure(
  loop: Loopback,
  cfg: ShareConfig,
  label: string,
  scripted?: { screen: TestScreen; video: HTMLVideoElement | null },
): Promise<Row> {
  scripted?.screen.restart();
  await sleep(WARMUP_MS);
  const snap = async () => ({ o: await statOf(loop.sender, 'outbound-rtp'), i: await statOf(loop.receiver, 'inbound-rtp') });
  if (scripted) {
    const waitFor = async (phase: number) => {
      let wait = phase - scripted.screen.phaseMs();
      if (wait < 0) wait += CYCLE_MS;
      await sleep(wait);
    };
    await waitFor(0);
    const s0 = await snap();
    await waitFor(3500);
    const still = checkStill(scripted.video, scripted.screen);
    await waitFor(4000);
    const s1 = await snap();
    await waitFor(8000);
    const s2 = await snap();
    await waitFor(0);
    const s3 = await snap();
    const row = summarize(cfg, label, s0.o, s3.o, s0.i, s3.i);
    const scrollSec = delta(s1.o, s2.o, 'timestamp') / 1000 || 4;
    const scrollFrames = delta(s1.o, s2.o, 'framesEncoded');
    return {
      ...row,
      scrollFps: scrollFrames / scrollSec,
      scrollKbps: (delta(s1.o, s2.o, 'bytesSent') * 8) / 1000 / scrollSec,
      scrollQp: scrollFrames > 0 ? delta(s1.o, s2.o, 'qpSum') / scrollFrames : NaN,
      stillKbps: (delta(s0.o, s1.o, 'bytesSent') * 8) / 1000 / (delta(s0.o, s1.o, 'timestamp') / 1000 || 4),
      psnr: still.psnr,
      pageNote: still.pageNote,
      crops: still.crops,
    };
  }
  const s1 = await snap();
  await sleep(MEASURE_MS);
  const s2 = await snap();
  return summarize(cfg, label, s1.o, s2.o, s1.i, s2.i);
}

function summarize(cfg: ShareConfig, label: string, o1: Stat | undefined, o2: Stat | undefined, i1: Stat | undefined, i2: Stat | undefined): Row {
  const d = delta;
  const sec = d(o1, o2, 'timestamp') / 1000 || MEASURE_MS / 1000;
  const encoded = d(o1, o2, 'framesEncoded');
  const decoded = d(i1, i2, 'framesDecoded');
  const encodeMs = encoded > 0 ? (d(o1, o2, 'totalEncodeTime') / encoded) * 1000 : NaN;
  const durations1 = (o1?.qualityLimitationDurations ?? {}) as Record<string, number>;
  const durations2 = (o2?.qualityLimitationDurations ?? {}) as Record<string, number>;
  const total = Object.keys(durations2).reduce((s, k) => s + (durations2[k] - (durations1[k] ?? 0)), 0);
  const limits = Object.keys(durations2)
    .filter((k) => k !== 'none' && total > 0 && (durations2[k] - (durations1[k] ?? 0)) / total >= 0.05)
    .map((k) => `${k} ${Math.round(((durations2[k] - (durations1[k] ?? 0)) / total) * 100)}%`);
  return {
    label,
    config: describe(cfg),
    sent: o2?.frameWidth ? `${o2.frameWidth}x${o2.frameHeight}` : '-',
    sentFps: encoded / sec,
    kbps: (d(o1, o2, 'bytesSent') * 8) / 1000 / sec,
    encodeMs,
    encodeLoad: (encodeMs * (encoded / sec)) / 1000,
    qp: encoded > 0 ? d(o1, o2, 'qpSum') / encoded : NaN,
    limit: limits.join(' ') || 'なし',
    encoder: `${o2?.encoderImplementation ?? '?'}${o2?.powerEfficientEncoder ? '(HW)' : ''}`,
    mode: o2?.scalabilityMode ?? '-',
    decodeMs: decoded > 0 ? (d(i1, i2, 'totalDecodeTime') / decoded) * 1000 : NaN,
    decodedFps: decoded / sec,
    freezes: d(i1, i2, 'freezeCount'),
    decoder: `${i2?.decoderImplementation ?? '?'}${i2?.powerEfficientDecoder ? '(HW)' : ''}`,
    encoderPsnr: (() => {
      const measured = d(o1, o2, 'psnrMeasurements');
      const y = (o2?.psnrSum?.y ?? 0) - (o1?.psnrSum?.y ?? 0);
      return measured > 0 ? y / measured : NaN;
    })(),
    scrollFps: NaN,
    scrollKbps: NaN,
    scrollQp: NaN,
    stillKbps: NaN,
    psnr: NaN,
  };
}

// ------------------------------------------------------------------ page

interface Source {
  track: MediaStreamTrack;
  stop: () => void;
  /** Set for scripted sources (test screen, screenshots): enables the per-phase numbers. */
  screen?: TestScreen;
}

export default function ScreenShareLabPage() {
  const [sourceKind, setSourceKind] = useState<'test' | 'images' | 'screen'>('test');
  const [suiteFilter, setSuiteFilter] = useState<'all' | 'vp8' | 'candidates'>('all');
  const imagesRef = useRef<ImageBitmap[]>([]);
  const [imageInfo, setImageInfo] = useState('');
  const [sourceInfo, setSourceInfo] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [manual, setManual] = useState(0);
  const [live, setLive] = useState<Row | null>(null);
  const [nativeSize, setNativeSize] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const sourceRef = useRef<Source | null>(null);
  const videoSourceRef = useRef<TestScreen | null>(null);
  const loopRef = useRef<Loopback | null>(null);
  const stopRef = useRef(false);
  const [gpu] = useState(gpuName);

  useEffect(
    () => () => {
      loopRef.current?.close();
      sourceRef.current?.stop();
      videoSourceRef.current?.stop();
    },
    [],
  );

  /**
   * The source for one config. Video rows get the moving test screen unless a live screen is
   * being shared (screenshots don't move).
   */
  const ensureSource = async (cfg: ShareConfig): Promise<Source> => {
    if (sourceKind !== 'screen' && cfg.mode === 'motion') {
      videoSourceRef.current ??= new TestScreen('video');
      const screen = videoSourceRef.current;
      return { track: screen.track, stop: () => screen.stop() };
    }
    if (sourceRef.current && sourceRef.current.track.readyState === 'live') return sourceRef.current;
    sourceRef.current?.stop();
    if (sourceKind !== 'screen') {
      if (sourceKind === 'images' && imagesRef.current.length === 0) throw new Error('スクリーンショットを選んでください');
      const screen = new TestScreen('document', sourceKind === 'images' ? imagesRef.current : undefined);
      sourceRef.current = { track: screen.track, stop: () => screen.stop(), screen };
      setSourceInfo(
        sourceKind === 'images'
          ? `スクリーンショット${imagesRef.current.length}枚 ${screen.canvas.width}x${screen.canvas.height}`
          : `テスト画面 ${SYNTH_W}x${SYNTH_H}`,
      );
      return sourceRef.current;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    sourceRef.current = { track, stop: () => track.stop() };
    setSourceInfo(`実際の画面 ${s.width}x${s.height}`);
    return sourceRef.current;
  };

  const scriptedFor = (source: Source, cfg: ShareConfig) =>
    source.screen && cfg.mode === 'text' ? { screen: source.screen, video: videoRef.current } : undefined;

  const loadImages = async (files: FileList | null) => {
    imagesRef.current.forEach((b) => b.close());
    imagesRef.current = [];
    sourceRef.current?.stop();
    sourceRef.current = null;
    if (!files) return;
    const bitmaps = await Promise.all([...files].filter((f) => f.type.startsWith('image/')).map((f) => createImageBitmap(f)));
    imagesRef.current = bitmaps;
    setImageInfo(bitmaps.length ? `${bitmaps.length}枚（1枚目 ${bitmaps[0].width}x${bitmaps[0].height}）` : '');
  };

  const show = (loop: Loopback) => {
    if (videoRef.current) videoRef.current.srcObject = loop.remoteStream;
  };

  const runSuite = async () => {
    setRunning(true);
    stopRef.current = false;
    setRows([]);
    try {
      const suite =
        suiteFilter === 'vp8'
          ? SUITE.filter((c) => c.codec === 'VP8')
          : suiteFilter === 'candidates'
            ? SUITE.filter((c) => CANDIDATES.has(c.label))
            : SUITE;
      for (const [i, cfg] of suite.entries()) {
        if (stopRef.current) break;
        const source = await ensureSource(cfg);
        if (!codecSupported(cfg.codec)) {
          setRows((r) => [...r, { ...emptyRow(cfg), error: 'このブラウザは非対応' }]);
          continue;
        }
        setStatus(`${i + 1}/${suite.length} ${cfg.label} を計測中…（約${scriptedFor(source, cfg) ? '20〜30' : (WARMUP_MS + MEASURE_MS) / 1000}秒）`);
        let row: Row | null = null;
        // A second try when the encoder produced nothing: right after the previous row's
        // connections close, an encoder occasionally never starts (seen with AV1 mid-suite).
        for (let attempt = 0; attempt < 2 && !row?.sentFps && !stopRef.current; attempt++) {
          let loop: Loopback | null = null;
          try {
            loop = await openLoopback(source.track, cfg);
            loopRef.current = loop;
            show(loop);
            row = await measure(loop, cfg, cfg.label, scriptedFor(source, cfg));
          } catch (err) {
            row = { ...emptyRow(cfg), error: err instanceof Error ? err.message : String(err) };
            break;
          } finally {
            loop?.close();
            loopRef.current = null;
            await sleep(1000);
          }
        }
        if (row && !row.error && !row.sentFps) row = { ...row, error: 'エンコーダが起動しませんでした（2回試行）' };
        if (row) setRows((r) => [...r, row]);
      }
      setStatus(stopRef.current ? '中止しました' : '完了');
      videoSourceRef.current?.stop();
      videoSourceRef.current = null;
    } catch (err) {
      setStatus(`エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  };

  const runManual = async () => {
    setRunning(true);
    stopRef.current = false;
    const cfg = SUITE[manual];
    try {
      const source = await ensureSource(cfg);
      const loop = await openLoopback(source.track, cfg);
      loopRef.current = loop;
      show(loop);
      setStatus(`${cfg.label} を表示中（計測が一巡するごとに数値を更新）`);
      while (!stopRef.current) setLive(await measure(loop, cfg, cfg.label, scriptedFor(source, cfg)));
    } catch (err) {
      setStatus(`エラー: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      loopRef.current?.close();
      loopRef.current = null;
      setRunning(false);
    }
  };

  const report = () =>
    [
      `■ 画面共有の実験 ${new Date().toLocaleString()} | ${navigator.userAgent.match(/(Edg|Chrome|Firefox|Version)\/[\d.]+/)?.[0] ?? '?'} | cores ${
        navigator.hardwareConcurrency
      } | ${gpu} | ${sourceInfo}`,
      '設定 | 送った解像度 | 一致度(PSNR dB) | エンコーダPSNR | スクロール中fps | スクロール中kbps | スクロール中QP | 静止中kbps | 平均fps | 平均kbps | 圧縮ms/コマ | 圧縮の負荷(1コア比) | QP | 制限 | エンコーダ | 層 | デコードms/コマ | 受信fps | 固まり | デコーダ',
      ...rows.map((r) =>
        r.error
          ? `${r.label} (${r.config}) | ${r.error}`
          : `${r.label} (${r.config}) | ${r.sent} | ${fmt(r.psnr, 2)}${r.pageNote ? `（ずれ: ${r.pageNote}）` : ''} | ${fmt(r.encoderPsnr, 1)} | ${fmt(r.scrollFps)} | ${fmt(r.scrollKbps, 0)} | ${fmt(r.scrollQp)} | ${fmt(r.stillKbps, 0)} | ${fmt(r.sentFps)} | ${fmt(r.kbps, 0)} | ${fmt(r.encodeMs)} | ${fmt(r.encodeLoad * 100, 0)}% | ${fmt(
              r.qp,
            )} | ${r.limit} | ${r.encoder} | ${r.mode} | ${fmt(r.decodeMs)} | ${fmt(r.decodedFps)} | ${r.freezes} | ${r.decoder}`,
      ),
    ].join('\n');

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 p-4 space-y-4 text-sm">
      <h1 className="text-lg font-bold">画面共有の実験</h1>
      <p className="text-gray-400 leading-relaxed">
        このPCの中で「送る側」と「受け取る側」をつないで、画面共有の設定ごとに圧縮・デコードの重さとビットレートを測ります。サーバーには何も送りません。計測中はこのタブを前面に出したままにしてください（約
        {Math.round((SUITE.length * (WARMUP_MS + MEASURE_MS)) / 60000)}分）。
      </p>
      <p className="text-gray-500 text-xs leading-relaxed">
        一致度（PSNR）: 静止している画面（どの設定も2ページ目＝2枚目の画像）を受け取った側から1枚取り出し、元の画面と比べた点数。高いほど元に近く、細かい文字が残っている（1〜2dBの差でも見た目に出ます）。
        エンコーダPSNR: Chromeが圧縮時に測る画質（送った解像度での値。Meetは約50dB）。縮小で失われた分は含まない。
        スクロール中fps: 上限まで出ていれば圧縮が追いついている。下がっていれば、文字をくっきり保つためにコマを捨てている。
      </p>
      <p className="text-gray-500 text-xs">GPU: {gpu}</p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          共有する画面:
          <select
            disabled={running}
            className="bg-gray-800 rounded px-2 py-1"
            value={sourceKind}
            onChange={(e) => {
              sourceRef.current?.stop();
              sourceRef.current = null;
              setSourceInfo('');
              setSourceKind(e.target.value as 'test' | 'images' | 'screen');
            }}
          >
            <option value="test">テスト画面（全PCで同じ条件）</option>
            <option value="images">スクリーンショットを動かす（実際の中身・毎回同じ動き）</option>
            <option value="screen">実際の画面を選ぶ（動きは自由・区間ごとの数字なし）</option>
          </select>
        </label>
        {sourceKind === 'images' && (
          <label className="flex items-center gap-2 text-xs">
            <input type="file" accept="image/*" multiple disabled={running} onChange={(e) => void loadImages(e.target.files)} />
            <span className="text-gray-400">{imageInfo || '同じ大きさの画像を3枚以上（全画面のスクリーンショット）'}</span>
          </label>
        )}
        <label className="flex items-center gap-1 text-xs text-gray-300">
          測る設定:
          <select
            disabled={running}
            className="bg-gray-800 rounded px-2 py-1"
            value={suiteFilter}
            onChange={(e) => setSuiteFilter(e.target.value as 'all' | 'vp8' | 'candidates')}
          >
            <option value="all">全部</option>
            <option value="vp8">VP8だけ</option>
            <option value="candidates">本番の候補だけ（約1.5分）</option>
          </select>
        </label>
        <button disabled={running} onClick={runSuite} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 font-bold disabled:opacity-50">
          全部の設定を自動で測る
        </button>
        <span className="text-gray-500">または</span>
        <select disabled={running} className="bg-gray-800 rounded px-2 py-1" value={manual} onChange={(e) => setManual(Number(e.target.value))}>
          {SUITE.map((cfg, i) => (
            <option key={cfg.label} value={i}>
              {cfg.label}（{describe(cfg)}）
            </option>
          ))}
        </select>
        <button disabled={running} onClick={runManual} className="px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50">
          この設定で見る
        </button>
        {running && (
          <button onClick={() => (stopRef.current = true)} className="px-3 py-2 rounded-lg bg-rose-700 hover:bg-rose-600">
            止める
          </button>
        )}
      </div>
      <div className="text-amber-300">
        {status} {sourceInfo && `| ${sourceInfo}`}
      </div>

      {live && (
        <div className="font-mono text-xs text-gray-300">
          {live.sent} 一致度 {fmt(live.psnr, 2)}dB | スクロール中 {fmt(live.scrollFps)}fps {fmt(live.scrollKbps, 0)}kbps QP {fmt(live.scrollQp)} | 平均 {fmt(live.sentFps)}fps {fmt(live.kbps, 0)}kbps | 圧縮 {fmt(live.encodeMs)}ms/コマ（1コアの{fmt(live.encodeLoad * 100, 0)}%） QP{' '}
          {fmt(live.qp)} 制限 {live.limit} {live.encoder} | デコード {fmt(live.decodeMs)}ms/コマ {live.decoder}
        </div>
      )}

      <section className="space-y-2">
        <div className="flex items-center gap-3">
          <h2 className="font-bold">受け取った画面</h2>
          <label className="flex items-center gap-1 text-xs text-gray-400">
            <input type="checkbox" checked={nativeSize} onChange={(e) => setNativeSize(e.target.checked)} />
            等倍で表示（文字の読みやすさを比べる用）
          </label>
        </div>
        <div className="max-h-[70vh] overflow-auto rounded border border-gray-800 bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className={nativeSize ? 'max-w-none' : 'w-full'}
          />
        </div>
      </section>

      {rows.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <h2 className="font-bold">結果</h2>
            <button onClick={() => void navigator.clipboard?.writeText(report())} className="px-3 py-1 rounded bg-gray-800 hover:bg-gray-700">
              コピー
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs font-mono whitespace-nowrap">
              <thead className="text-gray-400">
                <tr>
                  {['設定', '送った解像度', '一致度dB', 'エンコーダPSNR', 'スクロールfps', 'スクロールkbps', 'スクロールQP', '静止kbps', '平均fps', '平均kbps', '圧縮ms', '圧縮負荷', 'QP', '制限', 'エンコーダ', 'デコードms', '受信fps', '固まり'].map((h) => (
                    <th key={h} className="pr-3 text-left">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}>
                    <td className="pr-3">{r.label}</td>
                    {r.error ? (
                      <td colSpan={17} className="text-rose-400">
                        {r.error}
                      </td>
                    ) : (
                      <>
                        <td className="pr-3">{r.sent}</td>
                        <td className="pr-3">
                          {fmt(r.psnr, 2)}
                          {r.pageNote && <span className="text-rose-400">（ずれ: {r.pageNote}）</span>}
                        </td>
                        <td className="pr-3">{fmt(r.encoderPsnr, 1)}</td>
                        <td className="pr-3">{fmt(r.scrollFps)}</td>
                        <td className="pr-3">{fmt(r.scrollKbps, 0)}</td>
                        <td className="pr-3">{fmt(r.scrollQp)}</td>
                        <td className="pr-3">{fmt(r.stillKbps, 0)}</td>
                        <td className="pr-3">{fmt(r.sentFps)}</td>
                        <td className="pr-3">{fmt(r.kbps, 0)}</td>
                        <td className="pr-3">{fmt(r.encodeMs)}</td>
                        <td className="pr-3">{fmt(r.encodeLoad * 100, 0)}%</td>
                        <td className="pr-3">{fmt(r.qp)}</td>
                        <td className="pr-3">{r.limit}</td>
                        <td className="pr-3">{r.encoder}</td>
                        <td className="pr-3">{fmt(r.decodeMs)}</td>
                        <td className="pr-3">{fmt(r.decodedFps)}</td>
                        <td>{r.freezes}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <textarea readOnly value={report()} className="w-full h-48 bg-gray-900 rounded p-2 font-mono text-xs" />
        </section>
      )}

      {rows.some((r) => r.crops) && (
        <section className="space-y-3">
          <h2 className="font-bold">見た目の比較（2ページ目の静止画・等倍の一部。左: 元の画面 / 右: 受け取った画面）</h2>
          {rows
            .filter((r) => r.crops)
            .map((r) => (
              <div key={r.label} className="space-y-1">
                <div className="text-xs text-gray-300">
                  {r.label}（{r.config}）受信 {r.crops!.recvSize} | 一致度 {fmt(r.psnr, 2)}dB
                </div>
                <div className="flex gap-2 overflow-x-auto">
                  <img src={r.crops!.src} alt="元の画面" className="max-w-none" />
                  <img src={r.crops!.recv} alt="受け取った画面" className="max-w-none" />
                </div>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}

function emptyRow(cfg: ShareConfig): Row {
  return {
    label: cfg.label,
    config: describe(cfg),
    sent: '-',
    sentFps: NaN,
    kbps: NaN,
    encodeMs: NaN,
    encodeLoad: NaN,
    qp: NaN,
    limit: '-',
    encoder: '-',
    mode: '-',
    decodeMs: NaN,
    decodedFps: NaN,
    freezes: 0,
    decoder: '-',
    encoderPsnr: NaN,
    scrollFps: NaN,
    scrollKbps: NaN,
    scrollQp: NaN,
    stillKbps: NaN,
    psnr: NaN,
  };
}
