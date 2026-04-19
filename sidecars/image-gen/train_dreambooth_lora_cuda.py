#!/usr/bin/env python3
"""
DreamBooth LoRA Training Script for CUDA (NVIDIA GPUs)
Simplified training script using diffusers + PEFT for LoRA fine-tuning of Flux models.

This script is called as a subprocess by server_cuda.py to handle training
isolation and clean VRAM management.

Usage:
    python train_dreambooth_lora_cuda.py \
        --pretrained_model_name_or_path black-forest-labs/FLUX.1-dev \
        --instance_data_dir /path/to/images \
        --output_dir /path/to/output \
        --instance_prompt "a photo of TOK" \
        --resolution 512 \
        --train_batch_size 1 \
        --gradient_accumulation_steps 4 \
        --learning_rate 1e-4 \
        --max_train_steps 500 \
        --rank 8

Requirements:
    - torch (CUDA)
    - diffusers >= 0.29.0
    - peft >= 0.11.0
    - transformers
    - accelerate
"""

from __future__ import annotations

import argparse
import gc
import logging
import math
import os
import sys
from pathlib import Path
from typing import Optional

import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from tqdm.auto import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("dreambooth-lora")


class DreamBoothDataset(Dataset):
    """Dataset for DreamBooth training with image-caption pairs."""

    def __init__(
        self,
        instance_data_dir: str,
        instance_prompt: str,
        size: int = 512,
    ):
        self.instance_data_dir = Path(instance_data_dir)
        self.instance_prompt = instance_prompt
        self.size = size

        # Collect image files with their corresponding captions
        self.instance_images = []
        self.instance_prompts = []

        image_extensions = {".jpg", ".jpeg", ".png", ".webp"}
        for img_path in sorted(self.instance_data_dir.iterdir()):
            if img_path.suffix.lower() in image_extensions:
                self.instance_images.append(img_path)
                # Check for a .txt file with the same name for custom caption
                txt_path = img_path.with_suffix(".txt")
                if txt_path.exists():
                    caption = txt_path.read_text().strip()
                    self.instance_prompts.append(caption)
                else:
                    self.instance_prompts.append(instance_prompt)

        if not self.instance_images:
            raise ValueError(f"No images found in {instance_data_dir}")

        log.info(f"Found {len(self.instance_images)} training images")

    def __len__(self) -> int:
        return len(self.instance_images)

    def __getitem__(self, idx: int) -> dict:
        image_path = self.instance_images[idx]
        prompt = self.instance_prompts[idx]

        image = Image.open(image_path).convert("RGB")
        # Resize to training resolution
        image = image.resize((self.size, self.size), Image.LANCZOS)

        # Convert to tensor normalized to [-1, 1]
        import torchvision.transforms as transforms
        transform = transforms.Compose([
            transforms.ToTensor(),
            transforms.Normalize([0.5], [0.5]),
        ])
        pixel_values = transform(image)

        return {
            "pixel_values": pixel_values,
            "prompt": prompt,
        }


def parse_args():
    parser = argparse.ArgumentParser(description="DreamBooth LoRA training for Flux")
    parser.add_argument(
        "--pretrained_model_name_or_path",
        type=str,
        default="black-forest-labs/FLUX.1-dev",
        help="Model to fine-tune",
    )
    parser.add_argument(
        "--instance_data_dir",
        type=str,
        required=True,
        help="Directory containing training images",
    )
    parser.add_argument(
        "--output_dir",
        type=str,
        required=True,
        help="Output directory for trained LoRA",
    )
    parser.add_argument(
        "--instance_prompt",
        type=str,
        default="a photo of TOK",
        help="Prompt containing the trigger word",
    )
    parser.add_argument(
        "--resolution",
        type=int,
        default=512,
        help="Training image resolution",
    )
    parser.add_argument(
        "--train_batch_size",
        type=int,
        default=1,
        help="Batch size for training",
    )
    parser.add_argument(
        "--gradient_accumulation_steps",
        type=int,
        default=4,
        help="Gradient accumulation steps",
    )
    parser.add_argument(
        "--learning_rate",
        type=float,
        default=1e-4,
        help="Learning rate",
    )
    parser.add_argument(
        "--lr_scheduler",
        type=str,
        default="constant",
        help="Learning rate scheduler",
    )
    parser.add_argument(
        "--lr_warmup_steps",
        type=int,
        default=0,
        help="Learning rate warmup steps",
    )
    parser.add_argument(
        "--max_train_steps",
        type=int,
        default=500,
        help="Maximum training steps",
    )
    parser.add_argument(
        "--rank",
        type=int,
        default=8,
        help="LoRA rank",
    )
    parser.add_argument(
        "--mixed_precision",
        type=str,
        default="fp16",
        choices=["no", "fp16", "bf16"],
        help="Mixed precision training",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed",
    )
    parser.add_argument(
        "--checkpointing_steps",
        type=int,
        default=None,
        help="Save checkpoint every N steps",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    # Set seed for reproducibility
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)

    # Check CUDA
    if not torch.cuda.is_available():
        log.error("CUDA not available. This script requires an NVIDIA GPU.")
        sys.exit(1)

    device = torch.device("cuda")
    log.info(f"Using device: {device} ({torch.cuda.get_device_name()})")

    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)

    # Determine dtype for mixed precision
    if args.mixed_precision == "fp16":
        weight_dtype = torch.float16
    elif args.mixed_precision == "bf16":
        weight_dtype = torch.bfloat16
    else:
        weight_dtype = torch.float32

    log.info(f"Loading model {args.pretrained_model_name_or_path}...")

    try:
        from transformers import (
            BitsAndBytesConfig as BnBConfig,
            CLIPTextModel, T5EncoderModel,
            CLIPTokenizer, T5TokenizerFast,
        )
        from diffusers.models import FluxTransformer2DModel, AutoencoderKL
        from peft import LoraConfig, get_peft_model

        # ── Tokenizers (CPU only, tiny) ─────────────────────────────────────
        log.info("Loading tokenizers...")
        tokenizer = CLIPTokenizer.from_pretrained(
            args.pretrained_model_name_or_path, subfolder="tokenizer"
        )
        tokenizer_2 = T5TokenizerFast.from_pretrained(
            args.pretrained_model_name_or_path, subfolder="tokenizer_2"
        )

        # ── Transformer: 4-bit QLoRA ────────────────────────────────────────
        # Quantize base weights to 4-bit so the 12 B model fits in 12 GB VRAM
        log.info("Loading FLUX transformer in 4-bit QLoRA mode...")
        bnb_config = BnBConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
        transformer = FluxTransformer2DModel.from_pretrained(
            args.pretrained_model_name_or_path,
            subfolder="transformer",
            quantization_config=bnb_config,
            torch_dtype=torch.bfloat16,
        )
        # prepare_model_for_kbit_training is LLM-specific (calls get_input_embeddings).
        # For diffusion transformers: freeze base weights, then apply LoRA.
        # Do NOT cast norms to float32 — that causes dtype mismatches in attention
        # (norm outputs fp32 → Q/K become fp32, but V stays bfloat16 → SDPA crash).
        for param in transformer.parameters():
            param.requires_grad = False
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
        transformer = get_peft_model(transformer, lora_config)
        # Cast LoRA adapter params to bfloat16 so all attention paths use the same dtype.
        for name, param in transformer.named_parameters():
            if param.requires_grad:
                param.data = param.data.to(torch.bfloat16)
        transformer.print_trainable_parameters()

        # Sentinel values — VAE/text encoders will be loaded per-need below
        vae          = None
        text_encoder  = None
        text_encoder_2 = None
        is_flux = True

        # Placeholders filled during precompute phase
        flux_all_packed_latents  = None  # [N, seq_img, 64]
        flux_all_clip_embeds     = None  # [N, 768]
        flux_all_t5_embeds       = None  # [N, 512, 4096]
        flux_h = flux_w = None          # latent spatial dims

    except Exception as e:
        log.error(f"Failed to load model: {e}")
        log.info("Falling back to simplified Stable Diffusion LoRA training...")

        # Fallback to SD-based training which is more reliable
        from diffusers import StableDiffusionPipeline
        from peft import LoraConfig, get_peft_model

        pipe = StableDiffusionPipeline.from_pretrained(
            "stabilityai/stable-diffusion-2-1",
            torch_dtype=weight_dtype,
        )

        unet = pipe.unet

        lora_config = LoraConfig(
            r=args.rank,
            lora_alpha=args.rank,
            init_lora_weights="gaussian",
            target_modules=["to_q", "to_k", "to_v", "to_out.0"],
        )

        unet = get_peft_model(unet, lora_config)
        unet.print_trainable_parameters()
        unet.to(device)

        vae = pipe.vae.to(device)
        vae.requires_grad_(False)

        text_encoder = pipe.text_encoder.to(device)
        text_encoder.requires_grad_(False)

        tokenizer = pipe.tokenizer

        transformer = unet  # Use same variable name for simplified code
        text_encoder_2 = None
        tokenizer_2 = None

        del pipe
        gc.collect()
        torch.cuda.empty_cache()

    # Create dataset (always needed for image paths + prompts)
    dataset = DreamBoothDataset(
        instance_data_dir=args.instance_data_dir,
        instance_prompt=args.instance_prompt,
        size=args.resolution,
    )

    # ── FLUX: precompute VAE latents + text embeddings ──────────────────────
    # Do this BEFORE building the training dataloader so heavy encoders can
    # be freed from GPU before the transformer is moved there.
    if is_flux:
        import torchvision.transforms as TF
        from transformers import CLIPTextModel, T5EncoderModel
        from diffusers.models import AutoencoderKL

        img_transform = TF.Compose([
            TF.ToTensor(),
            TF.Normalize([0.5], [0.5]),
        ])

        # 1. VAE latents
        log.info("Precomputing VAE latents (loading VAE temporarily)...")
        _vae = AutoencoderKL.from_pretrained(
            args.pretrained_model_name_or_path, subfolder="vae",
            torch_dtype=weight_dtype,
        ).to(device)
        _vae.requires_grad_(False)
        _vae.eval()
        _shift  = getattr(_vae.config, "shift_factor",   0.1159)
        _scale  = getattr(_vae.config, "scaling_factor", 0.3611)
        _packed_list = []
        for img_path in dataset.instance_images:
            img = Image.open(img_path).convert("RGB").resize(
                (args.resolution, args.resolution), Image.LANCZOS
            )
            pv = img_transform(img).unsqueeze(0).to(device, dtype=weight_dtype)
            with torch.no_grad():
                lat = _vae.encode(pv).latent_dist.sample()
            lat = (lat - _shift) * _scale
            b, c, h, w = lat.shape
            packed = lat.view(b, c, h // 2, 2, w // 2, 2)
            packed = packed.permute(0, 2, 4, 1, 3, 5).reshape(b, (h // 2) * (w // 2), c * 4)
            _packed_list.append(packed.squeeze(0).cpu())
        flux_all_packed_latents = torch.stack(_packed_list)   # [N, seq_img, 64]
        flux_h, flux_w = h, w                                  # latent spatial dims
        del _vae; gc.collect(); torch.cuda.empty_cache()
        log.info(f"VAE done. Latent shape: {flux_all_packed_latents.shape}")

        # 2. CLIP pooled embeddings
        log.info("Precomputing CLIP embeddings (loading CLIP temporarily)...")
        _clip = CLIPTextModel.from_pretrained(
            args.pretrained_model_name_or_path, subfolder="text_encoder",
            torch_dtype=weight_dtype,
        ).to(device)
        _clip.requires_grad_(False)
        _clip.eval()
        _clip_list = []
        for prompt in dataset.instance_prompts:
            toks = tokenizer(
                [prompt], padding="max_length",
                max_length=tokenizer.model_max_length,
                truncation=True, return_tensors="pt",
            )
            with torch.no_grad():
                out = _clip(toks.input_ids.to(device), output_hidden_states=False)
            _clip_list.append(out.pooler_output.squeeze(0).cpu())
        flux_all_clip_embeds = torch.stack(_clip_list)         # [N, 768]
        del _clip; gc.collect(); torch.cuda.empty_cache()
        log.info(f"CLIP done. Embed shape: {flux_all_clip_embeds.shape}")

        # 3. T5 sequence embeddings
        log.info("Precomputing T5 embeddings (loading T5 temporarily)...")
        _t5 = T5EncoderModel.from_pretrained(
            args.pretrained_model_name_or_path, subfolder="text_encoder_2",
            torch_dtype=weight_dtype,
        ).to(device)
        _t5.requires_grad_(False)
        _t5.eval()
        _t5_list = []
        for prompt in dataset.instance_prompts:
            toks2 = tokenizer_2(
                [prompt], padding="max_length",
                max_length=tokenizer_2.model_max_length,
                truncation=True, return_tensors="pt",
            )
            with torch.no_grad():
                t5_out = _t5(toks2.input_ids.to(device))[0]
            _t5_list.append(t5_out.squeeze(0).cpu())
        flux_all_t5_embeds = torch.stack(_t5_list)             # [N, 512, 4096]
        del _t5; gc.collect(); torch.cuda.empty_cache()
        log.info(f"T5 done. Embed shape: {flux_all_t5_embeds.shape}")

        log.info("All embeddings precomputed. Moving transformer to GPU for training...")
        transformer.to(device)

    # SD fallback: build normal dataloader
    dataloader = DataLoader(
        dataset,
        batch_size=args.train_batch_size,
        shuffle=True,
        num_workers=0,
    )

    # Setup optimizer — only LoRA params need gradients
    optimizer = torch.optim.AdamW(
        filter(lambda p: p.requires_grad, transformer.parameters()),
        lr=args.learning_rate,
        betas=(0.9, 0.999),
        weight_decay=1e-2,
        eps=1e-8,
    )

    num_samples = len(dataset)
    # For FLUX we iterate sample-by-sample from cache; for SD we use dataloader
    steps_per_epoch = math.ceil(num_samples / args.train_batch_size)
    num_update_steps_per_epoch = math.ceil(steps_per_epoch / args.gradient_accumulation_steps)
    num_train_epochs = math.ceil(args.max_train_steps / num_update_steps_per_epoch)

    log.info(f"Training for {num_train_epochs} epochs ({args.max_train_steps} steps)")
    log.info(f"Dataset size: {num_samples} images")
    log.info(f"Batch size: {args.train_batch_size}")
    log.info(f"Gradient accumulation: {args.gradient_accumulation_steps}")
    log.info(f"Effective batch size: {args.train_batch_size * args.gradient_accumulation_steps}")

    # Noise scheduler
    if is_flux:
        from diffusers import FlowMatchEulerDiscreteScheduler
        noise_scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(
            args.pretrained_model_name_or_path,
            subfolder="scheduler",
        )
    else:
        from diffusers import DDPMScheduler
        noise_scheduler = DDPMScheduler.from_pretrained(
            "stabilityai/stable-diffusion-2-1",
            subfolder="scheduler",
        )

    # Training loop
    global_step = 0
    transformer.train()

    progress_bar = tqdm(
        range(args.max_train_steps),
        desc="Training",
        disable=False,
    )

    # Pre-build fixed FLUX position IDs (same for every step)
    if is_flux:
        h, w = flux_h, flux_w
        _img_ids = torch.zeros(h // 2, w // 2, 3, dtype=torch.bfloat16)
        _img_ids[..., 1] = torch.arange(h // 2).float().view(-1, 1)
        _img_ids[..., 2] = torch.arange(w // 2).float().view(1, -1)
        _img_ids_flat = _img_ids.reshape((h // 2) * (w // 2), 3)  # [seq_img, 3] — 2D
        txt_seq_len = flux_all_t5_embeds.shape[1]
        _txt_ids_flat = torch.zeros(txt_seq_len, 3, dtype=torch.bfloat16)  # [seq_txt, 3] — 2D

    indices = list(range(num_samples))

    for epoch in range(num_train_epochs):
        if global_step >= args.max_train_steps:
            break

        import random
        random.shuffle(indices)

        if is_flux:
            # ── FLUX: iterate over precomputed cache ──────────────────────
            for step, idx in enumerate(indices):
                if global_step >= args.max_train_steps:
                    break

                packed_latents = flux_all_packed_latents[idx].unsqueeze(0).to(device, dtype=torch.bfloat16)
                pooled_emb     = flux_all_clip_embeds[idx].unsqueeze(0).to(device, dtype=torch.bfloat16)
                t5_emb         = flux_all_t5_embeds[idx].unsqueeze(0).to(device, dtype=torch.bfloat16)

                batch_size = 1
                u      = torch.rand(batch_size, device=device, dtype=torch.bfloat16)
                sigmas = u.view(batch_size, 1, 1)
                noise  = torch.randn_like(packed_latents)
                noisy  = (1.0 - sigmas) * packed_latents + sigmas * noise

                img_ids = _img_ids_flat.to(device)   # [seq_img, 3] — 2D, no batch dim
                txt_ids = _txt_ids_flat.to(device)   # [seq_txt, 3] — 2D, no batch dim
                guidance = torch.full((batch_size,), 1.0, device=device, dtype=torch.bfloat16)

                model_pred = transformer(
                    hidden_states=noisy,
                    encoder_hidden_states=t5_emb,
                    pooled_projections=pooled_emb,
                    timestep=u,
                    img_ids=img_ids,
                    txt_ids=txt_ids,
                    guidance=guidance,
                    return_dict=False,
                )[0]

                target = noise - packed_latents
                loss = torch.nn.functional.mse_loss(
                    model_pred.float(), target.float(), reduction="mean"
                )
                loss = loss / args.gradient_accumulation_steps
                loss.backward()

                if (step + 1) % args.gradient_accumulation_steps == 0:
                    torch.nn.utils.clip_grad_norm_(transformer.parameters(), 1.0)
                    optimizer.step()
                    optimizer.zero_grad()
                    global_step += 1
                    progress_bar.update(1)
                    progress_bar.set_postfix({"loss": loss.item() * args.gradient_accumulation_steps})

                    if args.checkpointing_steps and global_step % args.checkpointing_steps == 0:
                        checkpoint_path = os.path.join(args.output_dir, f"checkpoint-{global_step}")
                        os.makedirs(checkpoint_path, exist_ok=True)
                        transformer.save_pretrained(checkpoint_path)
                        log.info(f"Saved checkpoint at step {global_step}")

        else:
            # ── SD: standard DDPM dataloader loop ────────────────────────
            for step, batch in enumerate(dataloader):
                if global_step >= args.max_train_steps:
                    break

                pixel_values = batch["pixel_values"].to(device, dtype=weight_dtype)
                prompts = batch["prompt"]

                with torch.no_grad():
                    latents = vae.encode(pixel_values).latent_dist.sample()
                    latents = latents * vae.config.scaling_factor

                batch_size = latents.shape[0]
                noise = torch.randn_like(latents)
                timesteps = torch.randint(
                    0, noise_scheduler.config.num_train_timesteps,
                    (batch_size,), device=device,
                ).long()
                noisy_latents = noise_scheduler.add_noise(latents, noise, timesteps)

                with torch.no_grad():
                    text_inputs = tokenizer(
                        prompts, padding="max_length",
                        max_length=tokenizer.model_max_length,
                        truncation=True, return_tensors="pt",
                    )
                    text_embeddings = text_encoder(text_inputs.input_ids.to(device))[0]

                model_pred = transformer(
                    noisy_latents, timesteps,
                    encoder_hidden_states=text_embeddings,
                ).sample

                loss = torch.nn.functional.mse_loss(
                    model_pred.float(), noise.float(), reduction="mean"
                )
                loss = loss / args.gradient_accumulation_steps
                loss.backward()

                if (step + 1) % args.gradient_accumulation_steps == 0:
                    torch.nn.utils.clip_grad_norm_(transformer.parameters(), 1.0)
                    optimizer.step()
                    optimizer.zero_grad()
                    global_step += 1
                    progress_bar.update(1)
                    progress_bar.set_postfix({"loss": loss.item() * args.gradient_accumulation_steps})

                    if args.checkpointing_steps and global_step % args.checkpointing_steps == 0:
                        checkpoint_path = os.path.join(args.output_dir, f"checkpoint-{global_step}")
                        os.makedirs(checkpoint_path, exist_ok=True)
                        transformer.save_pretrained(checkpoint_path)
                        log.info(f"Saved checkpoint at step {global_step}")

    progress_bar.close()

    # Save final model
    log.info(f"Saving trained LoRA to {args.output_dir}")
    transformer.save_pretrained(args.output_dir)

    # Also save as single adapter file for easier loading
    adapter_path = os.path.join(args.output_dir, "adapter_model.safetensors")
    if os.path.exists(adapter_path):
        # Rename to match expected naming convention
        final_path = os.path.join(args.output_dir, "lora_adapter.safetensors")
        os.rename(adapter_path, final_path)
        log.info(f"LoRA adapter saved to: {final_path}")

    log.info("Training complete!")


if __name__ == "__main__":
    main()
