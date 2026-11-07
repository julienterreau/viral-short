# ViralShort AI

Importe une vidéo longue, clique une fois : l'IA transcrit, choisit les meilleurs passages, les recadre en 9:16, ajoute des sous-titres animés (mot courant surligné), traduit, puis présente une galerie de Shorts à télécharger.

## Ce qui est implémenté
- Import (envoi en flux, jusqu'à `MAX_UPLOAD_MB`), file de traitement asynchrone, **progression réelle** par étape (importation, transcription, analyse, sélection, traduction, montage, exportation).
- Transcription mot à mot : faster-whisper (`worker/transcribe.py`).
- Sélection des passages par LLM (Ollama, Qwen2.5 par défaut, sans coût par token) : accroche, surprise, émotion, humour, etc. Les bornes sont recalées sur des phrases entières, 20–90 s, sans chevauchement ; secours heuristique **signalé dans l'interface** si l'IA est indisponible.
- Montage ffmpeg : découpe, recadrage 9:16, sous-titres ASS karaoké, normalisation audio.
- Traduction des sous-titres, titres et descriptions (LLM) ; chaque Short peut être régénéré ou traduit dans une autre langue.
- Galerie : lecteur, titre, durée, langue, mots, score, téléchargement, modification (titre, bornes, cadrage), régénération, export `.tar` avec `metadata.json`.
- Mot de passe, cookie signé, CSRF, limitation des essais.

## Pas implémenté (honnêtement)
- Suivi de visage et multi-intervenants : le cadrage est centré (réglable à la main).
- Suppression des silences, détection de changements de scène, transitions, amélioration audio au-delà de la normalisation.
- Doublage par voix IA.
- Miniatures stylisées (simple image extraite de la vidéo).
- **SaaS** : comptes clients, Stripe, quotas, stockage cloud. Un seul mot de passe pour l'instant ; voir la feuille de route.
- Le « score viral » est l'avis du modèle, pas une mesure.

## Lancer
```
APP_PASSWORD=un-mot-de-passe node server.js     # ffmpeg, python3 + faster-whisper, Ollama requis
docker compose up --build                        # ou tout en conteneurs
```
Variables : `APP_PASSWORD`, `OLLAMA_URL`, `CHAT_MODEL`, `WHISPER_MODEL` (small), `MAX_VIDEO_MINUTES` (120), `CONCURRENCY`, `RENDER_PARALLEL`, `SUB_FONT`, `DATA_DIR`.

## Tests
`npm test` : 6 tests, dont un pipeline complet sur une vraie vidéo générée avec ffmpeg (faux Whisper et faux Ollama). Vérifié : sortie 1080×1920, audio, durée, sous-titres incrustés, traduction, progression monotone, export, régénération.
**Non vérifié** : faster-whisper réel, qualité des choix de Qwen2.5 sur de vraies vidéos, performances, Docker, Kaggle.

## Feuille de route SaaS
1. Comptes (inscription/connexion) et propriété des projets. 2. Stripe : abonnements. 3. Quotas par formule (minutes, Shorts). 4. Stockage objet (S3/R2) et file de jobs (Redis). 5. Suivi de visage (OpenCV/MediaPipe). 6. Doublage. 7. Sauvegardes, observabilité, conformité (droits sur les vidéos importées, RGPD).
