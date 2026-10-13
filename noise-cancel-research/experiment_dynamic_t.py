"""
One streaming GTCRN model that accepts any number of frames per session.run() (dynamic time
axis), instead of one fixed-T file per batch size (T1 / T2 / T4). If it matches the fixed
models' output and speed, the browser can load a single file and pick 4, 2 or 1 frames per run
at will — e.g. all 4 frames normally, fewer when the machine falls behind.

Checks, per frames-per-run T in (1, 2, 4):
  - output vs the production T=1 model run frame by frame (should be float-rounding identical)
  - native single-thread cost per run, next to the fixed-T model of the same T

Exports: sample_noise/experiment/gtcrn_simple_dynT.onnx (WASM speed is measured separately from
the frontend folder, where onnxruntime-web is installed).

Run:  .venv/bin/python experiment_dynamic_t.py
"""
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import torch

from experiment_speedup import (
    CHECKPOINT, OUT, PROD_MODEL, GTCRN, StreamGTCRN, convert_to_stream,
    _patch_stream_convs_for_multi_frame, load, session, stft, zero_caches,
)

DYN_PATH = OUT / "gtcrn_simple_dynT.onnx"


def export_dynamic(path: Path):
    _patch_stream_convs_for_multi_frame()
    model = GTCRN().eval()
    model.load_state_dict(torch.load(CHECKPOINT, map_location="cpu")["model"])
    stream = StreamGTCRN().eval()
    convert_to_stream(stream, model)
    args = (torch.randn(1, 257, 4, 2), torch.zeros(2, 1, 16, 16, 33),
            torch.zeros(2, 3, 1, 1, 16), torch.zeros(2, 1, 33, 16))
    torch.onnx.export(
        stream, args, str(path),
        input_names=["mix", "conv_cache", "tra_cache", "inter_cache"],
        output_names=["enh", "conv_cache_out", "tra_cache_out", "inter_cache_out"],
        dynamic_axes={"mix": {2: "T"}, "enh": {2: "T"}},
        opset_version=11, dynamo=False,
    )
    # Deliberately not run through onnxsim like the fixed-T models: with a dynamic T it bakes a
    # wrong frequency size into the depthwise conv's cache Concat (ShapeInferenceError on load).
    # ONNX Runtime does its own constant folding at session creation anyway.
    onnx.checker.check_model(onnx.load(str(path)))


def run(sess, spec, T):
    conv, tra, inter = zero_caches()
    usable = spec.shape[2] - spec.shape[2] % 4
    outs, t0, runs = [], time.perf_counter(), 0
    for i in range(0, usable, T):
        out, conv, tra, inter = sess.run(None, {"mix": spec[:, :, i:i + T], "conv_cache": conv,
                                                "tra_cache": tra, "inter_cache": inter})
        outs.append(out)
        runs += 1
    return np.concatenate(outs, axis=2), (time.perf_counter() - t0) / runs


def main():
    if not DYN_PATH.exists():
        print("exporting dynamic-T model...", file=sys.stderr)
        export_dynamic(DYN_PATH)
    dyn = session(DYN_PATH)
    print("inputs:", [(i.name, i.shape) for i in dyn.get_inputs()][:1])

    fixed = {1: session(PROD_MODEL)}
    for T in (2, 4):
        p = OUT / f"gtcrn_simple_T{T}.onnx"
        if p.exists():
            fixed[T] = session(p)

    x = load("声だけ")
    noise = load("キーボードと物音")
    n = min(len(x), len(noise))
    spec = stft((x[:n] + noise[:n] * 0.5).astype("float32"))
    ref, _ = run(fixed[1], spec, 1)

    print("\nT  | dynamic: max|diff| vs T1   ms/run | fixed T model ms/run")
    for T in (1, 2, 4):
        out, cost = run(dyn, spec, T)
        diff = float(np.abs(out - ref[:, :, :out.shape[2]]).max())
        fixed_cost = f"{run(fixed[T], spec, T)[1] * 1000:.3f}" if T in fixed else "-"
        print(f"{T}  | {diff:.2e}                  {cost * 1000:.3f}  | {fixed_cost}")


if __name__ == "__main__":
    main()
