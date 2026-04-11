import torch
print("CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("Device:", torch.cuda.get_device_name(0))
    print("VRAM:", round(torch.cuda.get_device_properties(0).total_mem / 1024**3, 1), "GB")
else:
    print("Device: N/A")
    print("CUDA init error or no GPU found")
