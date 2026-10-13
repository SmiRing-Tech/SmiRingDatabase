"""
Speed-up experiments for the streaming GTCRN noise canceller used in SmiRing Connect
(frontend/src/lib/audio/gtcrn/). Two ideas for slow machines that can't run it in real time:

1. Batching (lossless): export a streaming model that takes T=4 frames per session.run()
   instead of 1. The browser already buffers 1024 samples (= 4 hops) before sending audio to
   the worker, so this adds no latency; it only cuts per-call overhead. Verified here by
   checking the T=4 model's output against the production T=1 model's, sample for sample.

2. Frame skipping (lossy): run the model on only every (k+1)-th frame and, for the frames in
   between, re-apply the last computed complex mask (enh / mix) to the new frame's spectrum.
   The model's recurrent caches simply don't advance on skipped frames.

Outputs:
  sample_noise/experiment/<variant>/<clip>.wav   for listening
  a metrics table on stdout (SI-SDR vs the clean voice for the synthetic noisy-speech mixes,
  residual level for noise-only clips, similarity to the full-rate output, per-frame cost)

Run:  .venv/bin/python experiment_speedup.py [frames_per_run, default 4]
"""
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import soundfile as sf
import torch

HERE = Path(__file__).parent
STREAM_DIR = HERE / "vendor" / "gtcrn" / "stream"
sys.path.insert(0, str(STREAM_DIR))
sys.path.insert(0, str(HERE / "vendor" / "gtcrn"))

from gtcrn import GTCRN  # noqa: E402
from gtcrn_stream import StreamGTCRN  # noqa: E402
from modules import convolution  # noqa: E402
from modules.convert import convert_to_stream  # noqa: E402

PROD_MODEL = STREAM_DIR / "onnx_models" / "gtcrn_simple.onnx"
CHECKPOINT = STREAM_DIR / "onnx_models" / "model_trained_on_dns3.tar"
WAV16K = HERE / "sample_noise" / "wav16k"
OUT = HERE / "sample_noise" / "experiment"
SR, N_FFT, HOP = 16000, 512, 256
# Frames per session.run() for the batched variant: `experiment_speedup.py 8` for T=8. Each extra
# frame beyond the browser's current 4-hop (1024-sample) buffer adds 16ms of latency.
BATCH = int(sys.argv[1]) if len(sys.argv) > 1 else 4

NOISE_ONLY = ["キーボードと物音", "サイレン", "バイクショート", "バイクロング", "高速道路"]
VOICE_ONLY = "声だけ"
VOICE_RMS, NOISE_RMS = 0.06, 0.04


# ---------------------------------------------------------------- multi-frame streaming export

def _patch_stream_convs_for_multi_frame():
    """The vendor stream convs update their cache with `inp[:, :, 1:]`, which is only right for
    exactly one new frame. Keep the last cache-length frames instead, so T>1 works."""
    for cls in (convolution.StreamConv2d, convolution.StreamConvTranspose2d):
        original = cls.forward

        def forward(self, x, cache, _original=original):
            out, _ = _original(self, x, cache)
            return out, torch.cat([cache, x], dim=2)[:, :, x.shape[2]:]

        cls.forward = forward


def export_batched_model(path: Path, frames: int):
    _patch_stream_convs_for_multi_frame()
    model = GTCRN().eval()
    model.load_state_dict(torch.load(CHECKPOINT, map_location="cpu")["model"])
    stream = StreamGTCRN().eval()
    convert_to_stream(stream, model)
    args = (
        torch.randn(1, 257, frames, 2),
        torch.zeros(2, 1, 16, 16, 33),
        torch.zeros(2, 3, 1, 1, 16),
        torch.zeros(2, 1, 33, 16),
    )
    torch.onnx.export(
        stream, args, str(path),
        input_names=["mix", "conv_cache", "tra_cache", "inter_cache"],
        output_names=["enh", "conv_cache_out", "tra_cache_out", "inter_cache_out"],
        opset_version=11, dynamo=False,
    )
    from onnxsim import simplify
    simplified, ok = simplify(onnx.load(str(path)))
    assert ok
    onnx.save(simplified, str(path))


# ---------------------------------------------------------------- audio helpers

def stft(x):
    s = torch.stft(torch.from_numpy(x), N_FFT, HOP, N_FFT, torch.hann_window(N_FFT).pow(0.5), return_complex=False)
    return s[None].numpy()  # (1, 257, T, 2)


def istft(spec):
    c = torch.view_as_complex(torch.from_numpy(np.ascontiguousarray(spec[0])))
    return torch.istft(c, N_FFT, HOP, N_FFT, torch.hann_window(N_FFT).pow(0.5)).numpy()


def session(path):
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1  # the browser runs single-threaded WASM
    so.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def zero_caches():
    return (np.zeros([2, 1, 16, 16, 33], "float32"), np.zeros([2, 3, 1, 1, 16], "float32"),
            np.zeros([2, 1, 33, 16], "float32"))


def run_full(sess, spec, frames=1):
    """Every frame through the model, `frames` at a time. Returns (enh spec, seconds per frame)."""
    conv, tra, inter = zero_caches()
    T = spec.shape[2]
    usable = T - T % frames
    outs, t0 = [], time.perf_counter()
    for i in range(0, usable, frames):
        out, conv, tra, inter = sess.run(None, {"mix": spec[:, :, i:i + frames], "conv_cache": conv,
                                                "tra_cache": tra, "inter_cache": inter})
        outs.append(out)
    elapsed = time.perf_counter() - t0
    enh = np.concatenate(outs, axis=2)
    if usable < T:  # tail shorter than a batch: pass through so lengths line up
        enh = np.concatenate([enh, spec[:, :, usable:]], axis=2)
    return enh, elapsed / usable


def run_skip(sess, spec, skip):
    """Model on every (skip+1)-th frame; in between, the last mask re-applied to the new frame."""
    conv, tra, inter = zero_caches()
    T = spec.shape[2]
    outs, mask, ran, t0 = [], None, 0, time.perf_counter()
    for i in range(T):
        frame = spec[:, :, i:i + 1]
        mix = frame[..., 0] + 1j * frame[..., 1]
        if i % (skip + 1) == 0 or mask is None:
            out, conv, tra, inter = sess.run(None, {"mix": frame, "conv_cache": conv,
                                                    "tra_cache": tra, "inter_cache": inter})
            ran += 1
            enh = out[..., 0] + 1j * out[..., 1]
            mask = enh / np.where(np.abs(mix) < 1e-8, 1e-8, mix)
            # A mask is a gain; cap its magnitude so a near-silent bin can't blow up when reused.
            mag = np.abs(mask)
            mask = np.where(mag > 2.0, mask * (2.0 / np.maximum(mag, 1e-12)), mask)
            outs.append(out)
        else:
            enh = mask * mix
            outs.append(np.stack([enh.real, enh.imag], axis=-1).astype("float32"))
    elapsed = time.perf_counter() - t0
    return np.concatenate(outs, axis=2), elapsed / T, ran / T


# ---------------------------------------------------------------- metrics

def rms(x):
    return float(np.sqrt(np.mean(x ** 2) + 1e-12))


def si_sdr(est, ref):
    n = min(len(est), len(ref))
    est, ref = est[:n] - est[:n].mean(), ref[:n] - ref[:n].mean()
    target = (est @ ref) / (ref @ ref + 1e-12) * ref
    return 10 * np.log10((target @ target) / ((est - target) @ (est - target) + 1e-12))


def load(name):
    x, sr = sf.read(str(WAV16K / f"{name}.wav"), dtype="float32")
    assert sr == SR
    return x


def normalize(x, target):
    return x * (target / rms(x))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    batched_path = OUT / f"gtcrn_simple_T{BATCH}.onnx"
    if not batched_path.exists():
        print(f"exporting T={BATCH} model...", file=sys.stderr)
        export_batched_model(batched_path, BATCH)
    prod, batched = session(PROD_MODEL), session(batched_path)

    voice = load(VOICE_ONLY)
    clips = []  # (name, noisy input, clean reference or None)
    for name in NOISE_ONLY:
        noise = load(name)
        clean = normalize(np.tile(voice, len(noise) // len(voice) + 1)[:len(noise)], VOICE_RMS)
        mix = normalize(noise, NOISE_RMS) + clean
        scale = min(1.0, 0.98 / np.abs(mix).max())
        clips.append((f"話し声+{name}", (mix * scale).astype("float32"), clean * scale))
        clips.append((f"雑音のみ_{name}", normalize(noise, NOISE_RMS).astype("float32"), None))

    variants = ["input", "full", f"batched_T{BATCH}", "skip1", "skip2", "skip3"]
    for v in variants:
        (OUT / v).mkdir(exist_ok=True)

    cost = {v: [] for v in variants[1:]}
    rows = []
    for name, x, clean in clips:
        spec = stft(x)
        full_spec, c_full = run_full(prod, spec, 1)
        bat_spec, c_bat = run_full(batched, spec, BATCH)
        s1_spec, c_s1, r1 = run_skip(prod, spec, 1)
        s2_spec, c_s2, r2 = run_skip(prod, spec, 2)
        s3_spec, c_s3, r3 = run_skip(prod, spec, 3)
        cost["full"].append(c_full)
        cost[f"batched_T{BATCH}"].append(c_bat)
        cost["skip1"].append(c_s1)
        cost["skip2"].append(c_s2)
        cost["skip3"].append(c_s3)

        outs = {"input": x, "full": istft(full_spec), f"batched_T{BATCH}": istft(bat_spec),
                "skip1": istft(s1_spec), "skip2": istft(s2_spec), "skip3": istft(s3_spec)}
        for v, y in outs.items():
            sf.write(str(OUT / v / f"{name}.wav"), y, SR)

        T = spec.shape[2] - spec.shape[2] % BATCH
        max_diff = float(np.abs(bat_spec[:, :, :T] - full_spec[:, :, :T]).max())
        row = {"clip": name, "batched_vs_full_maxdiff": max_diff}
        for v in ["input", "full", "skip1", "skip2", "skip3"]:
            y = outs[v]
            if clean is not None:
                row[f"sisdr_{v}"] = si_sdr(y, clean)
            else:
                row[f"level_{v}"] = 20 * np.log10(rms(y) / rms(x))
            if v.startswith("skip"):
                row[f"sim_{v}"] = si_sdr(y, outs["full"])
        rows.append(row)

    print("\n=== cost per 16ms frame (single-thread CPU, native ORT) ===")
    for v, cs in cost.items():
        ms = 1000 * float(np.mean(cs))
        print(f"  {v:12s} {ms:6.3f} ms/frame   ({ms / 16 * 100:5.1f}% of real time)")

    print("\n=== noisy speech: SI-SDR vs clean voice (higher = better) ===")
    print(f"  {'clip':28s} {'input':>7s} {'full':>7s} {'skip1':>7s} {'skip2':>7s} {'skip3':>7s}")
    for r in rows:
        if "sisdr_full" in r:
            print(f"  {r['clip']:28s} {r['sisdr_input']:7.1f} {r['sisdr_full']:7.1f} {r['sisdr_skip1']:7.1f} "
                  f"{r['sisdr_skip2']:7.1f} {r['sisdr_skip3']:7.1f}")

    print("\n=== noise only: output level relative to input, dB (lower = more removed) ===")
    print(f"  {'clip':28s} {'full':>7s} {'skip1':>7s} {'skip2':>7s} {'skip3':>7s}")
    for r in rows:
        if "level_full" in r:
            print(f"  {r['clip']:28s} {r['level_full']:7.1f} {r['level_skip1']:7.1f} {r['level_skip2']:7.1f} {r['level_skip3']:7.1f}")

    print(f"\n=== batched T={BATCH} vs full: max |difference| in output spectrum ===")
    print("  " + ", ".join(f"{r['clip']}: {r['batched_vs_full_maxdiff']:.2e}" for r in rows))
    print(f"\nlistening files: {OUT}/<variant>/<clip>.wav", file=sys.stderr)


if __name__ == "__main__":
    main()
