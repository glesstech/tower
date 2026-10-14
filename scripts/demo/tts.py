# Speaks one scene's narration with Kokoro (hexgrad/Kokoro-82M), a local neural TTS model.
# build.mjs runs it through uv, which fetches the model and its dependencies on first use:
#   uv run --python 3.12 --with kokoro --with soundfile --with pip python scripts/demo/tts.py <voice> <out.wav> <text>
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

voice, out, text = sys.argv[1], sys.argv[2], sys.argv[3]
pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")
audio = np.concatenate([chunk for _, _, chunk in pipe(text, voice=voice, speed=1.0)])
sf.write(out, audio, 24000)
