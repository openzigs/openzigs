# FluxQ Diagnostics Cheat Sheet

## Quick Status

```bash
# Server status (launchctl + health endpoint)
bash scripts/fluxq-ctl.sh status

# Live logs (stderr from launchd)
tail -f /tmp/fluxq-stderr.log

# Health JSON
curl -s http://127.0.0.1:5005/health | python3 -m json.tool

# List available models
curl -s http://127.0.0.1:5005/models | python3 -m json.tool
```

## Service Control

```bash
# Start / stop / restart
bash scripts/fluxq-ctl.sh start
bash scripts/fluxq-ctl.sh stop
bash scripts/fluxq-ctl.sh restart

# Sync source → deploy dir then restart
bash scripts/fluxq-ctl.sh sync
bash scripts/fluxq-ctl.sh restart

# Load a specific model (requires auth token)
TOKEN=$(grep FLUXQ_SECRET_TOKEN ~/fluxq-node/.env | cut -d= -f2)
curl -s -X POST http://127.0.0.1:5005/model \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"model":"flux"}'

# Unload model to free RAM
curl -s -X POST http://127.0.0.1:5005/unload \
  -H "Authorization: Bearer $TOKEN"
```

## Generate an Image

```bash
TOKEN=$(grep FLUXQ_SECRET_TOKEN ~/fluxq-node/.env | cut -d= -f2)

# Quick 512x512 test (outputs PNG to /tmp)
curl -s -X POST http://127.0.0.1:5005/generate \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"prompt":"A red fox in snow","width":512,"height":512,"model":"flux"}' \
  -o /tmp/flux-test.png

# Check generation time from response header
curl -s -w '\nTime: %{header_json}\n' -X POST http://127.0.0.1:5005/generate \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"prompt":"A cat on a windowsill","width":512,"height":512}' \
  -o /tmp/flux-test2.png -D -
```

## Performance Benchmarks (M2 Pro 32GB)

| Metric | Value |
|--------|-------|
| Model load (cold) | ~4 min |
| 512×512 @ 4 steps | ~5-6 min |
| 256×256 @ 4 steps | ~1-2 min (estimated) |
| Quantization | int4 (TinyGemm) transformer, int8 T5 |
| Memory usage | ~8-10 GB unified |

### Why ~5 min per 512×512 image?

FLUX.1-schnell has 57 transformer blocks. Each block has ~4 large linear layers (qkv, out_proj, mlp). At 512×512, the latent sequence length is 4096 tokens at 3072 dimensions.

Per-layer `torch._weight_int4pack_mm` on MPS:
- 3072→3072: ~183ms
- 3072→9216 (qkv): ~545ms
- 3072→12288 (mlp): ~729ms

Per block: ~1.6s × 57 blocks × 4 steps = **~365s**

This is the MPS Metal int4 matmul kernel throughput — not a software bottleneck. The same model runs ~30-35s on an A100 GPU.

## Debugging

### Check PyTorch/MPS Setup

```bash
~/fluxq-node/.venv/bin/python -c "
import torch
print('PyTorch:', torch.__version__)
print('MPS available:', torch.backends.mps.is_available())
print('MPS built:', torch.backends.mps.is_built())
"
```

### Check quanto + TinyGemm

```bash
~/fluxq-node/.venv/bin/python -c "
import optimum.quanto
print('quanto version:', optimum.quanto.__version__)
from optimum.quanto.tensor.weights.tinygemm import TinyGemmWeightQBitsTensor
print('TinyGemm available: True')
"
```

### Verify TinyGemm MPS Kernel

```bash
~/fluxq-node/.venv/bin/python -c "
import torch
# Test raw int4 pack/mm on MPS
w = torch.randn(256, 256, dtype=torch.bfloat16, device='mps')
packed = torch._convert_weight_to_int4pack(w.to(torch.int32).to(torch.uint8)[:,:128], 8)
print('int4pack works on MPS:', packed.device)
"
```

### Check Process Memory

```bash
# Find FluxQ PID
pgrep -f "server.py.*5005" || pgrep -f "uvicorn.*5005"

# Memory usage
ps -p $(pgrep -f "server.py") -o pid,rss,%mem,command

# MPS memory (from Python)
~/fluxq-node/.venv/bin/python -c "
import torch
print('MPS allocated:', torch.mps.current_allocated_memory() / 1e9, 'GB')
print('MPS driver:', torch.mps.driver_allocated_memory() / 1e9, 'GB')
"
```

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 30+ min model load | CPU→MPS TinyGemm repacking | Should be fixed (quantize on MPS) |
| "Ninja required" error | Missing ninja build tool | `pip install ninja` in fluxq venv |
| Black images with SDXL | float16 NaN on MPS | Use float32 (already set in server.py) |
| "contiguous" error | Non-contiguous tensor to int4pack_mm | PyTorch adds `.contiguous()` calls as needed |
| OOM / memory pressure | Model too large for RAM | Reduce resolution or use sdxl-turbo |
| Server won't start | Port in use or config error | Check `lsof -i :5005` and logs |

## Architecture

```
sidecars/image-gen/server.py    # Source (edit here)
~/fluxq-node/server.py          # Deployed copy (sync with fluxq-ctl.sh sync)
~/fluxq-node/.venv/             # Python venv with torch, diffusers, quanto
~/fluxq-node/.env               # FLUXQ_SECRET_TOKEN
~/Library/LaunchAgents/com.openzigs.fluxq.plist  # launchd service config
/tmp/fluxq-stderr.log           # Server logs (stderr redirect)
```

### Key Monkey-Patch

The server patches `WeightQBitsTensor.create` to enable `TinyGemmWeightQBitsTensor` on MPS (quanto only enables it for CPU/CUDA). This allows quantizing directly on the MPS device, creating native int4-packed tensors that dispatch through `torch._weight_int4pack_mm` — the fast Metal compute kernel.

Without this patch: quantize on CPU → move to MPS → unpack→repack every tensor = 30+ min.
With this patch: move bf16 to MPS → quantize on MPS = ~4 min.
