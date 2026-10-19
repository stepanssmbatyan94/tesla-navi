import subprocess
import os

PHRASES = {
    "welcome": "Բարև ձեզ, ես Գոռն եմ, ձեր հայերեն ձայնային նավիգատորը Tesla Navi-ում։ Բարի ճանապարհ։",
    "voice_switched": "Ընտրված է հայերեն ձայնը։ Բարի ճանապարհ։",
    "route_start": "Երթուղին կառուցված է։ Գնացինք։",
    "turn_left": "Թեքվեք ձախ։",
    "turn_right": "Թեքվեք աջ։",
    "keep_left": "Պահեք ձախ։",
    "keep_right": "Պահեք աջ։",
    "straight": "Շարունակեք ուղիղ։",
    "rerouting": "Երթուղու վերահաշվարկ։",
    "arrived": "Դուք հասել եք նպատակակետին։",
    "dist_250_left": "Երկու հարյուր հիսուն մետրից թեքվեք ձախ։",
    "dist_250_right": "Երկու հարյուր հիսուն մետրից թեքվեք աջ։",
    "dist_250_straight": "Երկու հարյուր հիսուն մետրից շարունակեք ուղիղ։",
    "dist_500_left": "Հինգ հարյուր մետրից թեքվեք ձախ։",
    "dist_500_right": "Հինգ հարյուր մետրից թեքվեք աջ։",
    "camera_ahead": "Ուշադրություն, առջևում տեսախցիկ է։",
    "speed_limit": "Ուշադրություն, նվազեցրեք արագությունը։"
}

MODEL = "models/armenian/hy_AM-gor-medium.onnx"
CONFIG = "models/armenian/hy_AM-gor-medium.onnx.json"
OUT_DIR = "sounds/hy"

os.makedirs(OUT_DIR, exist_ok=True)

for key, text in PHRASES.items():
    wav_path = f"{OUT_DIR}/{key}.wav"
    mp3_path = f"{OUT_DIR}/{key}.mp3"
    print(f"Generating {key}: {text}")
    
    # Run Piper
    p = subprocess.Popen(
        ["piper", "-m", MODEL, "-c", CONFIG, "-f", wav_path],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    stdout, stderr = p.communicate(input=text)
    if p.returncode != 0:
        print(f"Error generating {key}: {stderr}")
        continue
        
    # Convert WAV to high quality MP3
    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-codec:a", "libmp3lame", "-qscale:a", "2", mp3_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    if os.path.exists(wav_path):
        os.remove(wav_path)
    print(f"Saved {mp3_path} ({os.path.getsize(mp3_path)} bytes)")

print("All Armenian voice cues generated successfully!")
