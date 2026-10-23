---
name: add-voice-phrase
description: >
  Add or change a Tesla Navi voice prompt in all three languages: I18N text for
  ru/en (neural Edge voices) plus prerecorded Armenian clips for Gor and Suzie,
  the server mapping in getArmenianAudio and the generator script. Use when a
  new spoken prompt is added, a prompt says the wrong thing, or Armenian plays
  the wrong clip / the greeting ("добавь фразу", "озвучка", "голос говорит не то").
---

# add-voice-phrase

Armenian has no neural voice: `/api/tts?lang=hy` serves files from `sounds/hy/{gor,suzie}/<key>.mp3`, chosen by `getArmenianAudio()` in `server.js` from either the key itself (`text=dist_250_uturn`) or keywords in the Armenian text. An unmatched phrase answers 404 (only the chime plays), so every new prompt needs a clip **and** a mapping.

## 1. Pick the key and the texts

- Key: snake_case, distance prompts as `dist_<meters>_<maneuver>` (`dist_250_keep_left`).
- ru and en text go into `I18N` in `js/config.js` (all three dictionaries get the key; the `hy` entry is the Armenian text). Keep the prompt short: it is spoken while driving.
- Armenian: write it in the same register as the existing phrases (`Թեքվեք ձախ։`, `Երկու հարյուր հիսուն մետրից …`). If unsure of the wording, ask the user rather than guessing.

## 2. Generate the clips (local, no external service)

Add the phrase to `COMMON_PHRASES` in `scripts/generate_armenian_pack.py` so the pack stays reproducible. Do **not** rerun that script as a whole: it regenerates every clip and would replace the existing Suzie recordings. Generate only the new keys:

```python
# python3 -I gen.py <repo root>   (keep this script in the scratchpad, not the repo)
import os, subprocess, sys
root = sys.argv[1]
MODEL = os.path.join(root, "models/armenian/hy_AM-gor-medium.onnx")
PHRASES = {"<key>": "<Armenian text>"}
FEMALE = "asetrate=22050*1.28,atempo=1/1.28,equalizer=f=3200:t=q:w=1.5:g=3.5,equalizer=f=250:t=q:w=1.5:g=-4"
for voice, filt in (("gor", None), ("suzie", FEMALE)):
    for key, text in PHRASES.items():
        wav = os.path.join(root, f"sounds/hy/{voice}/{key}.wav")
        mp3 = os.path.join(root, f"sounds/hy/{voice}/{key}.mp3")
        subprocess.run(["piper", "-m", MODEL, "-c", MODEL + ".json", "-f", wav], input=text, text=True, capture_output=True, check=True)
        subprocess.run(["ffmpeg", "-y", "-i", wav] + (["-af", filt] if filt else []) + ["-codec:a", "libmp3lame", "-qscale:a", "2", mp3], capture_output=True, check=True)
        os.remove(wav)
        print(voice, key, os.path.getsize(mp3))
```

Needs `piper` and `ffmpeg` on PATH and the model in `models/armenian/` (git-ignored, local only). Older Suzie clips came from armtts.online (`scripts/generate_suzie_female.py`); that sends the text to a third-party service, so only use it if the user asks for a matching timbre. Check duration with `ffprobe` (1–3 s is normal).

## 3. Map it in `getArmenianAudio`

Add a branch matching the key and a distinctive Armenian keyword. Order matters: put specific matches (`պահեք`, `հետադարձ`, distance + maneuver) **before** the generic `ձախ`/`աջ` branches, otherwise "250 m keep left" matches "250 m left". Careful with `աջ`: it is also a substring of `առաջ` (ahead).

## 4. Call it from the client

Voice goes through `mapEngine.speakVoice(text)`. For hy pass the key or the Armenian text; for ru/en the neural voice reads the text. If the prompt depends on a maneuver modifier, extend `getTurnSpeech()` / the hy branch in `trackNavigationProgress` for every modifier (left, right, slight/keep, u-turn, straight).

## 5. Verify

Restart the server, then for both voices check that the key and the Armenian text map to the new file:

```bash
for v in gor suzie; do for t in "<key>" "<Armenian text>"; do
  h=$(curl -s "http://localhost:8199/api/tts?lang=hy&voice=$v&text=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$t")" | md5)
  echo "$v $t -> $(cd sounds/hy/$v && md5 -r *.mp3 | grep "^$h" | awk '{print $2}')"
done; done
```

Also re-run the mapping for the neighbouring phrases (turn_left/right, keep_left/right, dist_250_*) so the new branch didn't steal them, and confirm an unknown phrase still answers 404. Commit the new `.mp3` files together with the mapping.
