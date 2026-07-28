"""LiveKit Agent that republishes every human participant's microphone as a
DeepFilterNet3-denoised track (`enhanced-<identity>`), for the frontend to
play instead of the raw mic. See hetzner-livekit/agent and the frontend's
EnhancedAudioRenderer for the other half of this pipeline.

DeepFilterNet's Python package only exposes a batch `enhance(model, df_state,
audio)` call (it resets the model's recurrent state on every call) rather
than a persistent per-frame streaming API — see the plan doc for why we
didn't go down the ONNX/libDF route instead. To turn that into something
usable for a live call, we keep a rolling context window of raw audio per
track and re-run `enhance()` on the whole window every CHUNK_SECONDS,
emitting only the newest CHUNK_SECONDS tail of the output. Latency is
roughly CHUNK_SECONDS + inference time; quality depends on CONTEXT_SECONDS
giving the model enough history to produce a stable estimate by the time it
reaches the tail. Both are tunable via env vars since they need to be
verified against real CPU headroom on the Hetzner box, not guessed.
"""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from df.enhance import enhance, init_df
from df.model import ModelParams
from libdf import DF
from livekit import agents, rtc
from livekit.agents import AutoSubscribe, JobContext, JobProcess, JobRequest, WorkerOptions, cli

logger = logging.getLogger("noise-cancel-agent")

AGENT_IDENTITY = "noise-cancel-agent"
SAMPLE_RATE = 48000
NUM_CHANNELS = 1

CONTEXT_SECONDS = float(os.environ.get("DFN_CONTEXT_SECONDS", "1.0"))
CHUNK_SECONDS = float(os.environ.get("DFN_CHUNK_SECONDS", "0.1"))
CONTEXT_SAMPLES = int(CONTEXT_SECONDS * SAMPLE_RATE)
CHUNK_SAMPLES = int(CHUNK_SECONDS * SAMPLE_RATE)

# All enhance() calls in this process must run on this single worker thread:
# the loaded model resets/writes its recurrent hidden state as part of every
# call, so two calls running concurrently on the same model instance would
# corrupt each other's state. Each track gets its own DF (STFT/ISTFT) state
# below, but the model itself is shared and must stay serialized.
INFERENCE_EXECUTOR = ThreadPoolExecutor(max_workers=1)


def prewarm(proc: JobProcess) -> None:
    model, _df_state, _suffix = init_df()
    proc.userdata["dfn_model"] = model
    proc.userdata["dfn_params"] = ModelParams()


def _run_inference(model, df_state: DF, context: np.ndarray, chunk_samples: int) -> bytes:
    with torch.no_grad():
        audio = torch.from_numpy(context).unsqueeze(0)
        enhanced = enhance(model, df_state, audio, pad=True)
    enhanced_np = enhanced.squeeze(0).numpy()
    tail = enhanced_np[-chunk_samples:] if enhanced_np.shape[0] >= chunk_samples else enhanced_np
    tail = np.clip(tail, -1.0, 1.0)
    return (tail * 32767.0).astype(np.int16).tobytes()


async def _handle_track(ctx: JobContext, participant: rtc.RemoteParticipant, track: rtc.Track) -> None:
    identity = participant.identity
    logger.info("noise-cancel: start processing track for %s", identity)

    model = ctx.proc.userdata["dfn_model"]
    p: ModelParams = ctx.proc.userdata["dfn_params"]
    df_state = DF(sr=p.sr, fft_size=p.fft_size, hop_size=p.hop_size, nb_bands=p.nb_erb, min_nb_erb_freqs=p.min_nb_freqs)

    audio_stream = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=NUM_CHANNELS)
    source = rtc.AudioSource(SAMPLE_RATE, NUM_CHANNELS)
    pub_track = rtc.LocalAudioTrack.create_audio_track(f"enhanced-{identity}", source)
    options = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE)
    publication = await ctx.room.local_participant.publish_track(pub_track, options)

    loop = asyncio.get_event_loop()
    context = np.zeros(0, dtype=np.float32)
    pending = 0

    try:
        async for event in audio_stream:
            frame = event.frame
            samples = np.frombuffer(bytes(frame.data), dtype=np.int16).astype(np.float32) / 32768.0
            context = np.concatenate([context, samples])
            if context.shape[0] > CONTEXT_SAMPLES:
                context = context[-CONTEXT_SAMPLES:]
            pending += samples.shape[0]

            while pending >= CHUNK_SAMPLES:
                pcm_bytes = await loop.run_in_executor(
                    INFERENCE_EXECUTOR, _run_inference, model, df_state, context.copy(), CHUNK_SAMPLES
                )
                out_frame = rtc.AudioFrame(pcm_bytes, SAMPLE_RATE, NUM_CHANNELS, len(pcm_bytes) // 2)
                await source.capture_frame(out_frame)
                pending -= CHUNK_SAMPLES
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
            prewarm_fnc=prewarm,
            num_idle_processes=int(os.environ.get("DFN_NUM_IDLE_PROCESSES", "1")),
        )
    )
