#!/usr/bin/env python3
"""Transcription avec mots horodatés (faster-whisper). Usage : transcribe.py audio.wav sortie.json [langue|auto]
Écrit des lignes « PROGRESS 0.42 » sur stdout (progression réelle, d'après la position audio traitée).
NON TESTÉ ici : faster-whisper n'a pas pu être installé dans l'environnement de développement."""
import json, os, sys


def main():
    audio, out = sys.argv[1], sys.argv[2]
    lang = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "auto" else None
    from faster_whisper import WhisperModel
    size = os.environ.get("WHISPER_MODEL", "small")
    dev = "cuda" if os.environ.get("WHISPER_DEVICE", "auto") in ("auto", "cuda") and _has_cuda() else "cpu"
    model = WhisperModel(size, device=dev, compute_type="float16" if dev == "cuda" else "int8")
    segs, info = model.transcribe(audio, language=lang, word_timestamps=True, vad_filter=True)
    words = []
    for s in segs:
        for w in (s.words or []):
            words.append({"w": w.word.strip(), "s": round(w.start, 3), "e": round(w.end, 3)})
        if info.duration:
            print("PROGRESS %.3f" % min(1.0, s.end / info.duration), flush=True)
    json.dump({"language": info.language, "words": [w for w in words if w["w"]]}, open(out, "w"), ensure_ascii=False)


def _has_cuda():
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001
        return False


if __name__ == "__main__":
    main()
