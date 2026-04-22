# OpenZigs v2a sidecar — Video-to-Audio (MMAudio)

Generates a synchronized soundtrack for an existing silent video clip
using [MMAudio](https://github.com/hkchengrex/MMAudio) (MIT). Used by the
queue-master to post-process LTX-Video clips when the request includes
`audio: "auto"`.

## Endpoints

| Method | Path           | Purpose                                               |
| ------ | -------------- | ----------------------------------------------------- |
| GET    | `/health`      | Liveness + loaded-state                               |
| GET    | `/gpu-info`    | CUDA availability, VRAM, idle status                  |
| POST   | `/unload`      | Free VRAM (called by orchestrator between handoffs)   |
| POST   | `/generate`    | Submit a v2a job. Returns 202 + `job_id`              |
| GET    | `/status/{id}` | Poll job status: `pending` / `completed` / `failed`   |

## Request body — `POST /generate`

```jsonc
{
  "job_id": "abc-123",
  // Provide exactly one of:
  "video_path": "/abs/path/to/clip.mp4",
  "video_b64":  "<base64-encoded mp4>",

  "duration_sec": 8.0,         // defaults to V2A_DEFAULT_DURATION
  "prompt":       "ocean waves crashing",
  "negative_prompt": "music, speech",
  "seed":         42,
  "callback_url": "http://localhost:3000/api/v2a/callback"
}
```

Response: `{ "status": "accepted", "job_id": "abc-123" }`. The audio file
is written to `tempfile.gettempdir()/v2a_<job_id>.wav` and surfaced via
`GET /status/<job_id>` once complete.

## Configuration

See [`.env.example`](./.env.example). Key variables:

| Var                    | Default                    | Purpose                                              |
| ---------------------- | -------------------------- | ---------------------------------------------------- |
| `PORT`                 | `5012`                     | Listen port                                          |
| `V2A_MODEL`            | `hkchengrex/MMAudio`       | HF repo id                                           |
| `V2A_DEFAULT_DURATION` | `8.0`                      | Default clip length (s)                              |
| `V2A_MAX_DURATION`     | `30.0`                     | Hard cap                                             |
| `V2A_IDLE_TIMEOUT`     | `300`                      | Seconds of inactivity before unload                  |
| `WORKER_SECRET_TOKEN`  | _(unset)_                  | Bearer token; loopback deploys can leave it empty    |

## Running

```bash
# Local Python:
pip install -r requirements.txt
python server_cuda.py --port 5012

# Docker:
docker build -t openzigs/v2a .
docker run --gpus all -p 5012:5012 openzigs/v2a
```

## License

The sidecar code is part of OpenZigs (MIT). MMAudio itself is MIT-licensed
([source](https://github.com/hkchengrex/MMAudio/blob/main/LICENSE)). Weights
are downloaded from HuggingFace on first use; users are responsible for
accepting any HF-side click-through licenses.
