"""LiveKit Agent that republishes every human participant's microphone as a
DTLN-denoised track (`enhanced-<identity>`), for the frontend to play instead
of the raw mic. See hetzner-livekit/agent and the frontend's
SelectiveSubscriber for the other half of this pipeline.

We originally built this around DeepFilterNet3 (PyTorch), reprocessing a
rolling context window on every chunk since the `df` package only exposes a
batch `enhance()` call with no persistent per-frame state. That approach
needed far more CPU than the 2 vCPU / 4GB Hetzner box has — inference
couldn't keep up with real-time, causing a backlog that grew into multi-second
delay and choppy audio no matter how the window/chunk sizes were tuned.

livekit-plugins-dtln (self-hosted, ONNX Runtime, no PyTorch) is a true O(1)
per-frame streaming processor — its LSTM hidden state persists across calls,
so there's no window to reprocess. Measured locally: ~0.2ms average per
10ms frame after the first call. It plugs directly into rtc.AudioStream's
`noise_cancellation` hook, so this file no longer does any manual
chunking/buffering/executor work — we just relay whatever AudioStream hands
back.
"""

import asyncio
import logging
import os

import onnxruntime as ort

# onnxruntime's default InferenceSession sizes its thread pool for the
# host's full core count and spin-waits between calls (to minimize latency
# for throughput-oriented workloads). DTLN's models are tiny (~0.2ms/call)
# and called every 10ms per track, so that default trades a lot of CPU for
# no real benefit — observed as noise-agent pinned at 140%+ CPU on the
# 2 vCPU Hetzner box despite doing very little actual work per call. The
# plugin doesn't expose SessionOptions, so we patch onnxruntime's session
# constructor process-wide before it creates any sessions: single-threaded,
# sequential execution, spinning disabled (blocking wait instead).
_orig_ort_init = ort.InferenceSession.__init__


def _patched_ort_init(self, *args, **kwargs):
    if kwargs.get("sess_options") is None:
        so = ort.SessionOptions()
        so.intra_op_num_threads = 1
        so.inter_op_num_threads = 1
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.add_session_config_entry("session.intra_op.allow_spinning", "0")
        so.add_session_config_entry("session.inter_op.allow_spinning", "0")
        kwargs["sess_options"] = so
    _orig_ort_init(self, *args, **kwargs)


ort.InferenceSession.__init__ = _patched_ort_init

from livekit import rtc  # noqa: E402
from livekit.agents import AutoSubscribe, JobContext, JobRequest, WorkerOptions, cli  # noqa: E402
from livekit.plugins import dtln  # noqa: E402

logger = logging.getLogger("noise-cancel-agent")

AGENT_IDENTITY = "noise-cancel-agent"
SAMPLE_RATE = 48000
NUM_CHANNELS = 1
DTLN_STRENGTH = float(os.environ.get("DTLN_STRENGTH", "0.5"))


async def _handle_track(ctx: JobContext, participant: rtc.RemoteParticipant, track: rtc.Track) -> None:
    identity = participant.identity
    logger.info("noise-cancel: start processing track for %s", identity)

    # Stateful (LSTM hidden state) — must be one instance per track, not shared.
    denoiser = dtln.noise_suppression(strength=DTLN_STRENGTH)
    audio_stream = rtc.AudioStream(
        track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS, noise_cancellation=denoiser
    )
    source = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
    pub_track = rtc.LocalAudioTrack.create_audio_track(f"enhanced-{identity}", source)
    options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    publication = await ctx.room.local_participant.publish_track(pub_track, options)

    try:
        async for event in audio_stream:
            await source.capture_frame(event.frame)
    except Exception:
        logger.exception("noise-cancel: pipeline error for %s", identity)
    finally:
        await audio_stream.aclose()
        try:
            await ctx.room.local_participant.unpublish_track(publication.sid)
        except Exception:
            logger.exception("noise-cancel: failed to unpublish enhanced track for %s", identity)
        logger.info("noise-cancel: stopped processing track for %s", identity)


async def entrypoint(ctx: JobContext) -> None:
    tasks: dict[str, asyncio.Task] = {}

    def on_track_subscribed(
        track: rtc.Track, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant
    ) -> None:
        if track.kind != rtc.TrackKind.KIND_AUDIO or publication.source != rtc.TrackSource.SOURCE_MICROPHONE:
            return
        if participant.identity == AGENT_IDENTITY:
            return
        tasks[track.sid] = asyncio.create_task(_handle_track(ctx, participant, track))

    def on_track_unsubscribed(
        track: rtc.Track, _publication: rtc.RemoteTrackPublication, _participant: rtc.RemoteParticipant
    ) -> None:
        pending_task = tasks.pop(track.sid, None)
        if pending_task is not None:
            pending_task.cancel()

    ctx.room.on("track_subscribed", on_track_subscribed)
    ctx.room.on("track_unsubscribed", on_track_unsubscribed)

    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)


async def request_fnc(req: JobRequest) -> None:
    await req.accept(identity=AGENT_IDENTITY, name="Noise Cancel Agent")


if __name__ == "__main__":
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=request_fnc,
            num_idle_processes=int(os.environ.get("DFN_NUM_IDLE_PROCESSES", "1")),
        )
    )
