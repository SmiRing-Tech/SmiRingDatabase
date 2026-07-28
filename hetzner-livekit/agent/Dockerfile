FROM python:3.11-slim

WORKDIR /app

# DeepFilterNet's logger shells out to `git rev-parse` to log a commit hash
# and only catches the "not a repo" case, not "git missing" — python:3.11-slim
# has no git binary, which crashes init_df() at both build time (the prewarm
# step below) and container startup.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# torch/torchaudio must come from the CPU wheel index first, otherwise plain
# `pip install` resolves the much larger CUDA build from PyPI.
RUN pip install --no-cache-dir torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir deepfilternet==0.5.6 livekit-agents==1.6.7 numpy

COPY main.py .

# init_df() fetches the pretrained DeepFilterNet3 checkpoint over the network
# on first use and caches it under ~/.cache/DeepFilterNet. Do that once at
# build time so the container never needs network access for it and doesn't
# re-download on every restart.
RUN LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=build LIVEKIT_API_SECRET=buildbuildbuildbuildbuildbuild \
    python -c "from df.enhance import init_df; init_df()"

CMD ["python", "main.py", "start"]
