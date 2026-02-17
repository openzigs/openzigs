FROM python:3.12-slim

WORKDIR /app

# System deps for soundfile + audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

ENV AUDIO_PORT=5006
ENV AUDIO_HOST=0.0.0.0
ENV AUDIO_IDLE_TIMEOUT=300

EXPOSE 5006

CMD ["python", "server.py"]
