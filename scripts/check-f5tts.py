from f5_tts.api import F5TTS
import inspect
sig = inspect.signature(F5TTS.__init__)
print("Signature:", sig)
for name, param in sig.parameters.items():
    print(f"  {name}: default={param.default}")
