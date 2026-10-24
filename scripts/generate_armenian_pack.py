import subprocess
import os

COMMON_PHRASES = {
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
    "dist_250_keep_left": "Երկու հարյուր հիսուն մետրից պահեք ձախ։",
    "dist_250_keep_right": "Երկու հարյուր հիսուն մետրից պահեք աջ։",
    "dist_250_uturn": "Երկու հարյուր հիսուն մետրից կատարեք հետադարձ։",
    "uturn": "Կատարեք հետադարձ։",
    "camera_ahead": "Ուշադրություն, առջևում տեսախցիկ է։",
    "speed_limit": "Ուշադրություն, նվազեցրեք արագությունը։",
    "roundabout": "Շրջանաձև երթևեկություն։",
    "dist_250_roundabout": "Երկու հարյուր հիսուն մետրից շրջանաձև երթևեկություն։",
    **{f"roundabout_exit_{i + 1}": f"Շրջանաձև երթևեկությունում դուրս եկեք {o} ելքով։"
       for i, o in enumerate(["առաջին", "երկրորդ", "երրորդ", "չորրորդ", "հինգերորդ", "վեցերորդ"])}
}

GOR_PHRASES = {
    **COMMON_PHRASES,
    "welcome": "Բարև ձեզ, ես Գոռն եմ, ձեր հայերեն ձայնային նավիգատորը Tesla Navi-ում։ Բարի ճանապարհ։",
    "voice_switched": "Ընտրված է Գոռի ձայնը։ Բարի ճանապարհ։"
}

SUZIE_PHRASES = {
    **COMMON_PHRASES,
    "welcome": "Բարև ձեզ, ես Սյուզին եմ, ձեր հայերեն ձայնային նավիգատորը Tesla Navi-ում։ Բարի ճանապարհ։",
    "voice_switched": "Ընտրված է Սյուզիի ձայնը։ Բարի ճանապարհ։"
}

MODEL = "models/armenian/hy_AM-gor-medium.onnx"
CONFIG = "models/armenian/hy_AM-gor-medium.onnx.json"

def generate_voice(name, phrases, is_female=False):
    out_dir = f"sounds/hy/{name}"
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs("sounds/hy", exist_ok=True)
    
    print(f"\n🎙️ Generating voice pack: {name.upper()} ({'Female' if is_female else 'Male'})...")
    
    for key, text in phrases.items():
        wav_path = f"{out_dir}/{key}.wav"
        mp3_path = f"{out_dir}/{key}.mp3"
        
        p = subprocess.Popen(
            ["piper", "-m", MODEL, "-c", CONFIG, "-f", wav_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        p.communicate(input=text)
        
        if is_female:
            # Feminine acoustic filter: pitch up by +28%, correct tempo back to 1.0, brighten formant
            filter_str = "asetrate=22050*1.28,atempo=1/1.28,equalizer=f=3200:t=q:w=1.5:g=3.5,equalizer=f=250:t=q:w=1.5:g=-4"
            subprocess.run(
                ["ffmpeg", "-y", "-i", wav_path, "-af", filter_str, "-codec:a", "libmp3lame", "-qscale:a", "2", mp3_path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        else:
            subprocess.run(
                ["ffmpeg", "-y", "-i", wav_path, "-codec:a", "libmp3lame", "-qscale:a", "2", mp3_path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            # Also keep root copy for backward compatibility
            root_mp3 = f"sounds/hy/{key}.mp3"
            subprocess.run(["cp", mp3_path, root_mp3])
            
        if os.path.exists(wav_path):
            os.remove(wav_path)
            
        print(f"[{name}] {key} -> {mp3_path} ({os.path.getsize(mp3_path)} B)")

generate_voice("gor", GOR_PHRASES, is_female=False)
generate_voice("suzie", SUZIE_PHRASES, is_female=True)

print("\n✅ All Gor and Suzie Armenian voice packs generated successfully!")
