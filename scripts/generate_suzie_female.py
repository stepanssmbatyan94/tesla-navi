import urllib.request
import urllib.parse
import subprocess
import os
import time

PHRASES = {
    "welcome": "Բարև ձեզ, ես Սյուզին եմ, ձեր հայերեն ձայնային նավիգատորը Tesla Navi-ում։ Բարի ճանապարհ։",
    "voice_switched": "Ընտրված է Սյուզիի ձայնը։ Բարի ճանապարհ։",
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

OUT_DIR = "sounds/hy/suzie"
os.makedirs(OUT_DIR, exist_ok=True)

print("🎙️ Generating authentic Armenian female voice (Suzie) from Armenian TTS engine...")

for key, text in PHRASES.items():
    raw_path = f"{OUT_DIR}/{key}_raw.mp3"
    mp3_path = f"{OUT_DIR}/{key}.mp3"
    print(f"Synthesizing [{key}]: {text}")
    
    cmd = [
        "curl", "-s", "-k", "-X", "POST",
        "-F", f"text={text}",
        "-F", "sid=1",
        "https://armtts.online:5000/play",
        "-o", raw_path
    ]
    subprocess.run(cmd, check=True)
    
    # Optimize to clean 24kHz MP3 with slight volume normalization
    subprocess.run(
        ["ffmpeg", "-y", "-i", raw_path, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "24000", "-b:a", "48k", mp3_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    if os.path.exists(raw_path):
        os.remove(raw_path)
        
    print(f"Saved {mp3_path} ({os.path.getsize(mp3_path)} bytes)")
    time.sleep(0.3)

print("✅ Authentic Armenian female voice pack (Suzie) completed successfully!")
