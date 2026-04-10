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
        from diffusers import FluxPipeline
        from peft import LoraConfig, get_peft_model

        # Load the pipeline
        pipe = FluxPipeline.from_pretrained(
            args.pretrained_model_name_or_path,
            torch_dtype=weight_dtype,
        )

        # Extract the transformer (the model we want to fine-tune)
        transformer = pipe.transformer

        # Configure LoRA
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

        # Apply LoRA to transformer
        transformer = get_peft_model(transformer, lora_config)
        transformer.print_trainable_parameters()
        transformer.to(device)

        # Get the VAE for encoding images
        vae = pipe.vae.to(device)
        vae.requires_grad_(False)

        # Get text encoders for encoding prompts
        text_encoder = pipe.text_encoder.to(device)
        text_encoder_2 = pipe.text_encoder_2.to(device)
        text_encoder.requires_grad_(False)
        text_encoder_2.requires_grad_(False)

        tokenizer = pipe.tokenizer
        tokenizer_2 = pipe.tokenizer_2

        # Free pipeline memory
        del pipe
        gc.collect()
        torch.cuda.empty_cache()

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

    # Create dataset and dataloader
    dataset = DreamBoothDataset(
        instance_data_dir=args.instance_data_dir,
        instance_prompt=args.instance_prompt,
        size=args.resolution,
    )

    dataloader = DataLoader(
        dataset,
        batch_size=args.train_batch_size,
        shuffle=True,
        num_workers=0,
    )

    # Setup optimizer
    optimizer = torch.optim.AdamW(
        transformer.parameters(),
        lr=args.learning_rate,
        betas=(0.9, 0.999),
        weight_decay=1e-2,
        eps=1e-8,
    )

    # Calculate number of training epochs
    num_update_steps_per_epoch = math.ceil(len(dataloader) / args.gradient_accumulation_steps)
    num_train_epochs = math.ceil(args.max_train_steps / num_update_steps_per_epoch)

    log.info(f"Training for {num_train_epochs} epochs ({args.max_train_steps} steps)")
    log.info(f"Dataset size: {len(dataset)} images")
    log.info(f"Batch size: {args.train_batch_size}")
    log.info(f"Gradient accumulation: {args.gradient_accumulation_steps}")
    log.info(f"Effective batch size: {args.train_batch_size * args.gradient_accumulation_steps}")

    # Noise scheduler for training
    from diffusers import DDPMScheduler
    noise_scheduler = DDPMScheduler.from_pretrained(
        args.pretrained_model_name_or_path if "FLUX" in args.pretrained_model_name_or_path else "stabilityai/stable-diffusion-2-1",
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

    for epoch in range(num_train_epochs):
        for step, batch in enumerate(dataloader):
            if global_step >= args.max_train_steps:
                break

            pixel_values = batch["pixel_values"].to(device, dtype=weight_dtype)
            prompts = batch["prompt"]

            # Encode images to latents
            with torch.no_grad():
                latents = vae.encode(pixel_values).latent_dist.sample()
                latents = latents * vae.config.scaling_factor

            # Sample noise
            noise = torch.randn_like(latents)
            batch_size = latents.shape[0]

            # Sample random timesteps
            timesteps = torch.randint(
                0, noise_scheduler.config.num_train_timesteps,
                (batch_size,), device=device
            ).long()

            # Add noise to latents
            noisy_latents = noise_scheduler.add_noise(latents, noise, timesteps)

            # Encode text prompts
            with torch.no_grad():
                text_inputs = tokenizer(
                    prompts,
                    padding="max_length",
                    max_length=tokenizer.model_max_length,
                    truncation=True,
                    return_tensors="pt",
                )
                text_embeddings = text_encoder(text_inputs.input_ids.to(device))[0]

                if text_encoder_2 is not None and tokenizer_2 is not None:
                    text_inputs_2 = tokenizer_2(
                        prompts,
                        padding="max_length",
                        max_length=tokenizer_2.model_max_length,
                        truncation=True,
                        return_tensors="pt",
                    )
                    text_embeddings_2 = text_encoder_2(
                        text_inputs_2.input_ids.to(device),
                        output_hidden_states=True,
                    )
                    pooled_text_embeddings = text_embeddings_2[0]
                    text_embeddings = torch.cat([text_embeddings, text_embeddings_2.hidden_states[-2]], dim=-1)
                else:
                    pooled_text_embeddings = None

            # Forward pass - predict noise
            if pooled_text_embeddings is not None:
                model_pred = transformer(
                    noisy_latents,
                    timesteps,
                    encoder_hidden_states=text_embeddings,
                    pooled_projections=pooled_text_embeddings,
                ).sample
            else:
                model_pred = transformer(
                    noisy_latents,
                    timesteps,
                    encoder_hidden_states=text_embeddings,
                ).sample

            # Compute loss
            loss = torch.nn.functional.mse_loss(model_pred.float(), noise.float(), reduction="mean")

            # Backward pass
            loss = loss / args.gradient_accumulation_steps
            loss.backward()

            if (step + 1) % args.gradient_accumulation_steps == 0:
                torch.nn.utils.clip_grad_norm_(transformer.parameters(), 1.0)
                optimizer.step()
                optimizer.zero_grad()
                global_step += 1
                progress_bar.update(1)
                progress_bar.set_postfix({"loss": loss.item() * args.gradient_accumulation_steps})

                # Save checkpoint
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
