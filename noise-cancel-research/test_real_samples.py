"""
Runs the real noise samples in sample_noise/wav16k/ through the same streaming
ONNX GTCRN pipeline validated in vendor/gtcrn/stream/gtcrn_stream.py (frame-by-
frame, explicit conv_cache/tra_cache/inter_cache state, 16kHz, 512/256 STFT).

For each pure-noise clip, also builds a synthetic "noise while talking" mix by
looping/trimming 声だけ.wav (voice-only) to the noise clip's own length, so we
can hear both "does it kill the noise" and "does it clip the voice" per
category. 人の声.wav (already a real mixed recording, competing speech) and
声だけ.wav (clean baseline) are run as-is.

All lengths are whatever was recorded — deliberately not normalized, since a
mismatch in real recording length is exactly what production audio looks like.
"""
import sys
from pathlib import Path

import numpy as np
import onnxruntime
import soundfile as sf

HERE = Path(__file__).parent
WAV16K = HERE / "sample_noise" / "wav16k"
MIXED = HERE / "sample_noise" / "mixed"
ENHANCED = HERE / "sample_noise" / "enhanced"
ONNX_MODEL = HERE / "vendor" / "gtcrn" / "stream" / "onnx_models" / "gtcrn_simple.onnx"

SR = 16000
N_FFT, HOP, WIN = 512, 256, 512
NOISE_ONLY_FILES = ["キーボードと物音", "サイレン", "バイクショート", "バイクロング", "高速道路"]
VOICE_ONLY = "声だけ"
MIXED_SPEECH = "人の声"

VOICE_RMS_TARGET = 0.06
NOISE_RMS_TARGET = 0.04


def load(name: str) -> np.ndarray:
    x, sr = sf.read(str(WAV16K / f"{name}.wav"), dtype="float32")
    assert sr == SR
    return x


def rms_normalize(x: np.ndarray, target: float) -> np.ndarray:
    current = np.sqrt(np.mean(x**2) + 1e-12)
    return x * (target / current)


def make_noisy_speech(noise: np.ndarray, voice: np.ndarray) -> np.ndarray:
    """Loops/trims voice to noise's length, mixes at fixed RMS targets, peak-safes."""
    n = len(noise)
    reps = n // len(voice) + 1
    voice_matched = np.tile(voice, reps)[:n]
    mix = rms_normalize(noise, NOISE_RMS_TARGET) + rms_normalize(voice_matched, VOICE_RMS_TARGET)
    peak = np.abs(mix).max()
    if peak > 0.98:
        mix = mix * (0.98 / peak)
    return mix.astype(np.float32)


def enhance(x: np.ndarray, session: onnxruntime.InferenceSession) -> np.ndarray:
    import torch

    xt = torch.from_numpy(x)
    spec = torch.stft(xt, N_FFT, HOP, WIN, torch.hann_window(WIN).pow(0.5), return_complex=False)[None]
    spec = spec.numpy()  # (1, 257, T, 2)

    conv_cache = np.zeros([2, 1, 16, 16, 33], dtype="float32")
    tra_cache = np.zeros([2, 3, 1, 1, 16], dtype="float32")
    inter_cache = np.zeros([2, 1, 33, 16], dtype="float32")

    outs = []
    for i in range(spec.shape[-2]):
        out_i, conv_cache, tra_cache, inter_cache = session.run(
            [],
            {
                "mix": spec[:, :, i : i + 1, :],
                "conv_cache": conv_cache,
                "tra_cache": tra_cache,
                "inter_cache": inter_cache,
            },
        )
        outs.append(out_i)
    out = np.concatenate(outs, axis=2)

    out_t = torch.from_numpy(out)
    out_complex = torch.view_as_complex(out_t.contiguous())
    y = torch.istft(out_complex, N_FFT, HOP, WIN, torch.hann_window(WIN).pow(0.5)).numpy()
    return y.squeeze()


def main():
    MIXED.mkdir(parents=True, exist_ok=True)
    ENHANCED.mkdir(parents=True, exist_ok=True)

    session = onnxruntime.InferenceSession(str(ONNX_MODEL), providers=["CPUExecutionProvider"])
    voice = load(VOICE_ONLY)

    jobs = []  # (label, input_array)
    jobs.append(("voice_only_baseline", voice))
    jobs.append(("mixed_speech_as_recorded", load(MIXED_SPEECH)))
    for name in NOISE_ONLY_FILES:
        noise = load(name)
        jobs.append((f"noise_only__{name}", noise))
        noisy_speech = make_noisy_speech(noise, voice)
        sf.write(str(MIXED / f"noisy_speech__{name}.wav"), noisy_speech, SR)
        jobs.append((f"noisy_speech__{name}", noisy_speech))

    for label, x in jobs:
        print(f"processing {label} ({len(x)/SR:.1f}s)...", file=sys.stderr)
        y = enhance(x, session)
        sf.write(str(ENHANCED / f"{label}__input.wav"), x, SR)
        sf.write(str(ENHANCED / f"{label}__output.wav"), y, SR)

    print("done.", file=sys.stderr)


if __name__ == "__main__":
    main()
