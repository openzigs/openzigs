#!/usr/bin/env python3
"""
DreamBooth LoRA Training Script for SDXL on CUDA (12 GB GPUs)

Trains a LoRA adapter on Stable Diffusion XL at 1024px resolution.
Designed to fit on a 12 GB RTX 3060 with:
  - gradient checkpointing
  - 8-bit AdamW (bitsandbytes)
  - fp16 mixed precision
  - xformers memory-efficient attention

The trained .safetensors adapter is SDXL-specific and must be loaded
with an SDXL pipeline at inference time (not FLUX).

Called as a subprocess by server_cuda.py.

Usage:
    python train_dreambooth_lora_sdxl_cuda.py \
        --instance_data_dir /path/to/images \
        --output_dir /path/to/output \
        --instance_prompt "a photo of TOK person" \
        --resolution 1024 \
        --train_batch_size 1 \
        --gradient_accumulation_steps 1 \
        --learning_rate 1e-4 \
        --max_train_steps 500 \
        --rank 16

Requirements:
    - torch (CUDA)
    - diffusers >= 0.29.0
    - peft >= 0.11.0
    - transformers
    - bitsandbytes (for 8-bit Adam)
"""

from __future__ import annotations

import argparse
import gc
import logging
import math
import os
import random
import sys
from pathlib import Path

import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from tqdm.auto import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("dreambooth-sdxl-lora")

# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------

class DreamBoothDataset(Dataset):
    """Image-caption pairs for DreamBooth training."""

    def __init__(self, instance_data_dir: str, instance_prompt: str, size: int = 1024):
        self.size = size
        self.instance_images: list[Path] = []
        self.instance_prompts: list[str] = []

        data_dir = Path(instance_data_dir)
        exts = {".jpg", ".jpeg", ".png", ".webp"}
        for img_path in sorted(data_dir.iterdir()):
            if img_path.suffix.lower() in exts:
                self.instance_images.append(img_path)
                txt_path = img_path.with_suffix(".txt")
                if txt_path.exists():
                    self.instance_prompts.append(txt_path.read_text().strip())
                else:
                    self.instance_prompts.append(instance_prompt)

        if not self.instance_images:
            raise ValueError(f"No images found in {instance_data_dir}")
        log.info(f"Found {len(self.instance_images)} training images")

    def __len__(self) -> int:
        return len(self.instance_images)

    def __getitem__(self, idx: int) -> dict:
        import torchvision.transforms as T

        image = Image.open(self.instance_images[idx]).convert("RGB")
        image = image.resize((self.size, self.size), Image.LANCZOS)
        transform = T.Compose([T.ToTensor(), T.Normalize([0.5], [0.5])])
        return {"pixel_values": transform(image), "prompt": self.instance_prompts[idx]}


# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(description="DreamBooth LoRA training for SDXL")
    p.add_argument("--pretrained_model_name_or_path", type=str,
                    default="stabilityai/stable-diffusion-xl-base-1.0")
    p.add_argument("--instance_data_dir", type=str, required=True)
    p.add_argument("--output_dir", type=str, required=True)
    p.add_argument("--instance_prompt", type=str, default="a photo of TOK person")
    p.add_argument("--resolution", type=int, default=1024)
    p.add_argument("--train_batch_size", type=int, default=1)
    p.add_argument("--gradient_accumulation_steps", type=int, default=1)
    p.add_argument("--learning_rate", type=float, default=1e-4)
    p.add_argument("--lr_scheduler", type=str, default="constant")
    p.add_argument("--lr_warmup_steps", type=int, default=0)
    p.add_argument("--max_train_steps", type=int, default=500)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--mixed_precision", type=str, default="fp16",
                    choices=["no", "fp16", "bf16"])
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--checkpointing_steps", type=int, default=None)
    p.add_argument("--use_8bit_adam", action="store_true", default=True)
    return p.parse_args()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    args = parse_args()

    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)

    if not torch.cuda.is_available():
        log.error("CUDA not available. This script requires an NVIDIA GPU.")
        sys.exit(1)

    device = torch.device("cuda")
    gpu_name = torch.cuda.get_device_name()
    vram_total = torch.cuda.get_device_properties(0).total_memory / 1024**3
    log.info(f"Using device: {device} ({gpu_name}, {vram_total:.1f} GB)")

    os.makedirs(args.output_dir, exist_ok=True)

    if args.mixed_precision == "fp16":
        weight_dtype = torch.float16
    elif args.mixed_precision == "bf16":
        weight_dtype = torch.bfloat16
    else:
        weight_dtype = torch.float32

    # ── Load SDXL pipeline ──────────────────────────────────────────────────
    log.info(f"Loading SDXL from {args.pretrained_model_name_or_path} ...")
    from diffusers import StableDiffusionXLPipeline, DDPMScheduler
    from peft import LoraConfig, get_peft_model

    pipe = StableDiffusionXLPipeline.from_pretrained(
        args.pretrained_model_name_or_path,
        torch_dtype=weight_dtype,
        variant="fp16",
        use_safetensors=True,
    )

    unet = pipe.unet
    vae = pipe.vae
    text_encoder = pipe.text_encoder
    text_encoder_2 = pipe.text_encoder_2
    tokenizer = pipe.tokenizer
    tokenizer_2 = pipe.tokenizer_2
    noise_scheduler = DDPMScheduler.from_pretrained(
        args.pretrained_model_name_or_path, subfolder="scheduler"
    )

    # Free the full pipeline shell (we keep the components)
    del pipe
    gc.collect()

    # ── Freeze base model, apply LoRA to UNet only ──────────────────────────
    vae.requires_grad_(False)
    text_encoder.requires_grad_(False)
    text_encoder_2.requires_grad_(False)
    unet.requires_grad_(False)

    # Enable gradient checkpointing to reduce VRAM (trades compute for memory)
    unet.enable_gradient_checkpointing()

    lora_config = LoraConfig(
        r=args.rank,
        lora_alpha=args.rank,
        init_lora_weights="gaussian",
        target_modules=[
            "to_q", "to_k", "to_v", "to_out.0",
            "proj_in", "proj_out",
            "ff.net.0.proj", "ff.net.2",
        ],
    )
    unet = get_peft_model(unet, lora_config)
    unet.print_trainable_parameters()

    # Move to device — base model in fp16, LoRA trainable params upcast to fp32.
    # GradScaler requires fp32 gradients; autocast handles the fp16⇄fp32 boundary
    # in the forward pass so mixed dtypes don't produce NaN.
    # NOTE: VAE must stay in float32 — the SDXL VAE is numerically unstable in
    # fp16 and produces NaN latents, which propagates as NaN loss through training.
    vae.to(device, dtype=torch.float32)
    text_encoder.to(device, dtype=weight_dtype)
    text_encoder_2.to(device, dtype=weight_dtype)
    unet.to(device, dtype=weight_dtype)

    # Upcast LoRA trainable params to float32 so GradScaler can unscale gradients.
    for p in unet.parameters():
        if p.requires_grad:
            p.data = p.data.float()

    # Enable xformers if available
    try:
        unet.enable_xformers_memory_efficient_attention()
        log.info("xformers memory-efficient attention enabled")
    except Exception:
        log.info("xformers not available, using default attention")

    # ── Dataset & DataLoader ────────────────────────────────────────────────
    dataset = DreamBoothDataset(
        instance_data_dir=args.instance_data_dir,
        instance_prompt=args.instance_prompt,
        size=args.resolution,
    )
    dataloader = DataLoader(dataset, batch_size=args.train_batch_size, shuffle=True, num_workers=0)

    # ── Optimizer ───────────────────────────────────────────────────────────
    trainable_params = list(filter(lambda p: p.requires_grad, unet.parameters()))

    if args.use_8bit_adam:
        try:
            import bitsandbytes as bnb
            optimizer_cls = bnb.optim.AdamW8bit
            log.info("Using 8-bit AdamW optimizer (bitsandbytes)")
        except ImportError:
            log.warning("bitsandbytes not found, falling back to standard AdamW")
            optimizer_cls = torch.optim.AdamW
    else:
        optimizer_cls = torch.optim.AdamW

    optimizer = optimizer_cls(
        trainable_params,
        lr=args.learning_rate,
        betas=(0.9, 0.999),
        weight_decay=1e-2,
        eps=1e-8,
    )

    # ── LR scheduler ───────────────────────────────────────────────────────
    from diffusers.optimization import get_scheduler
    lr_scheduler = get_scheduler(
        args.lr_scheduler,
        optimizer=optimizer,
        num_warmup_steps=args.lr_warmup_steps,
        num_training_steps=args.max_train_steps,
    )

    steps_per_epoch = math.ceil(len(dataset) / args.train_batch_size)
    num_update_steps_per_epoch = math.ceil(steps_per_epoch / args.gradient_accumulation_steps)
    num_train_epochs = math.ceil(args.max_train_steps / num_update_steps_per_epoch)

    log.info(f"Training config:")
    log.info(f"  Resolution: {args.resolution}px")
    log.info(f"  Dataset: {len(dataset)} images")
    log.info(f"  Epochs: {num_train_epochs}")
    log.info(f"  Steps: {args.max_train_steps}")
    log.info(f"  Batch size: {args.train_batch_size}")
    log.info(f"  Grad accumulation: {args.gradient_accumulation_steps}")
    log.info(f"  LoRA rank: {args.rank}")
    log.info(f"  Learning rate: {args.learning_rate}")

    vram_used = torch.cuda.memory_allocated() / 1024**3
    vram_reserved = torch.cuda.memory_reserved() / 1024**3
    log.info(f"VRAM before training: {vram_used:.1f} GB allocated, {vram_reserved:.1f} GB reserved")

    # ── Training Loop ──────────────────────────────────────────────────────
    # GradScaler prevents fp16 gradient underflow by scaling the loss up before
    # backward (amplifying gradients), then unscaling before the optimizer step.
    scaler = torch.amp.GradScaler('cuda')
    global_step = 0
    unet.train()
    progress_bar = tqdm(range(args.max_train_steps), desc="Training")

    for epoch in range(num_train_epochs):
        if global_step >= args.max_train_steps:
            break

        for step, batch in enumerate(dataloader):
            if global_step >= args.max_train_steps:
                break

            pixel_values = batch["pixel_values"].to(device, dtype=torch.float32)
            prompts = batch["prompt"]

            # Encode images to latents
            # VAE runs in float32 (SDXL VAE is numerically unstable in fp16).
            # Cast latents to fp16 afterward for the UNet forward pass.
            with torch.no_grad():
                latents = vae.encode(pixel_values).latent_dist.sample()
                latents = latents * vae.config.scaling_factor
                latents = latents.to(weight_dtype)  # fp32 → fp16 for UNet

            # Sample noise and timesteps
            noise = torch.randn_like(latents)
            batch_size = latents.shape[0]
            timesteps = torch.randint(
                0, noise_scheduler.config.num_train_timesteps,
                (batch_size,), device=device,
            ).long()
            noisy_latents = noise_scheduler.add_noise(latents, noise, timesteps)

            # Encode text with both SDXL text encoders
            with torch.no_grad():
                # Text encoder 1 (CLIP ViT-L)
                text_inputs_1 = tokenizer(
                    prompts, padding="max_length",
                    max_length=tokenizer.model_max_length,
                    truncation=True, return_tensors="pt",
                )
                text_out_1 = text_encoder(text_inputs_1.input_ids.to(device), output_hidden_states=True)
                prompt_embeds_1 = text_out_1.hidden_states[-2]  # penultimate layer

                # Text encoder 2 (CLIP ViT-bigG)
                text_inputs_2 = tokenizer_2(
                    prompts, padding="max_length",
                    max_length=tokenizer_2.model_max_length,
                    truncation=True, return_tensors="pt",
                )
                text_out_2 = text_encoder_2(text_inputs_2.input_ids.to(device), output_hidden_states=True)
                prompt_embeds_2 = text_out_2.hidden_states[-2]  # penultimate layer
                pooled_prompt_embeds = text_out_2[0]  # pooler output

                # Concatenate for SDXL's dual encoder
                prompt_embeds = torch.cat([prompt_embeds_1, prompt_embeds_2], dim=-1)

            # SDXL requires add_time_ids (original_size, crop_coords, target_size)
            add_time_ids = torch.tensor(
                [[args.resolution, args.resolution, 0, 0, args.resolution, args.resolution]],
                dtype=weight_dtype, device=device,
            ).repeat(batch_size, 1)

            added_cond_kwargs = {
                "text_embeds": pooled_prompt_embeds,
                "time_ids": add_time_ids,
            }

            # Forward pass — autocast handles fp32 LoRA ↔ fp16 base weight boundary
            with torch.amp.autocast('cuda', dtype=torch.float16):
                model_pred = unet(
                    noisy_latents, timesteps,
                    encoder_hidden_states=prompt_embeds,
                    added_cond_kwargs=added_cond_kwargs,
                ).sample

            # MSE loss against noise (epsilon prediction)
            loss = torch.nn.functional.mse_loss(model_pred.float(), noise.float(), reduction="mean")
            loss = loss / args.gradient_accumulation_steps
            scaler.scale(loss).backward()

            if (step + 1) % args.gradient_accumulation_steps == 0:
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(unet.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                lr_scheduler.step()
                optimizer.zero_grad()
                global_step += 1
                progress_bar.update(1)
                progress_bar.set_postfix({"loss": loss.item() * args.gradient_accumulation_steps})

                if args.checkpointing_steps and global_step % args.checkpointing_steps == 0:
                    ckpt_path = os.path.join(args.output_dir, f"checkpoint-{global_step}")
                    os.makedirs(ckpt_path, exist_ok=True)
                    unet.save_pretrained(ckpt_path)
                    log.info(f"Saved checkpoint at step {global_step}")

        # Log epoch stats
        vram_used = torch.cuda.memory_allocated() / 1024**3
        log.info(f"Epoch {epoch + 1}/{num_train_epochs} done. VRAM: {vram_used:.1f} GB")

    progress_bar.close()

    # ── Save final LoRA adapter ─────────────────────────────────────────────
    log.info(f"Saving SDXL LoRA adapter to {args.output_dir}")
    unet.save_pretrained(args.output_dir)

    # Also save metadata so inference knows this is an SDXL adapter
    import json
    metadata = {
        "base_model": args.pretrained_model_name_or_path,
        "architecture": "sdxl",
        "resolution": args.resolution,
        "rank": args.rank,
        "max_train_steps": args.max_train_steps,
        "learning_rate": args.learning_rate,
    }
    with open(os.path.join(args.output_dir, "training_metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    adapter_path = os.path.join(args.output_dir, "adapter_model.safetensors")
    if os.path.exists(adapter_path):
        final_path = os.path.join(args.output_dir, "lora_adapter.safetensors")
        os.rename(adapter_path, final_path)
        log.info(f"SDXL LoRA adapter saved to: {final_path}")

    # Cleanup
    del unet, vae, text_encoder, text_encoder_2
    gc.collect()
    torch.cuda.empty_cache()
    log.info("Training complete!")


if __name__ == "__main__":
    main()
