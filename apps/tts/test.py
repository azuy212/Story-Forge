import torchaudio as ta
from chatterbox.tts import ChatterboxTTS

device = "mps"
model = ChatterboxTTS.from_pretrained(device=device)
text = """
Artificial intelligence is transforming how humans create stories,
videos, and experiences.
"""
wav = model.generate(text)
ta.save("output.wav", wav, model.sr)
print("Generated output.wav")
