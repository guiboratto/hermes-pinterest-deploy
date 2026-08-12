# UGC Video Spec — Late-Night Gym Vlog
# Source: Ivanka/Oleg 2026-08-12 (Seedance 2.5 reference)
# Status: Avatar rendered (1088x1920, gym setting). Pipeline planning.

## Target
30-second video, 10 cuts × 3 sec each, vertical 9:16 (1088x1920).

## Render strategy (corrected after 2026-08-10 failure)
❌ OLD: Scene-by-scene t2v chaining → different woman+product each scene
✅ NEW: ONE avatar reused across ALL scenes (lipsync, camera moves)

## Pipeline per ASIN
1. **Avatar** — already rendered `avatar_01.jpg` (brunette gym influencer)
2. **Per scene** — Wan2GP LTX-2 i2v: avatar + scene prompt + camera instruction
3. **Lipsync** — wav2vec + SadTalker overlay on each scene
4. **Audio** — Edge TTS for 10 dialogue lines, mixed with subtle gym ambience
5. **Product composite** — REAL Amazon listing images (water bottle scene)
6. **Edit** — FFmpeg concat + jump cuts + DV color grade

## Scenes (verbatim from spec)
1. arm's-length selfie walk + "Okay… late-night gym vlog."
2. handheld pan to room + "It's basically empty in here."
3. mirror selfie + ponytail adjust + "I look tired, but we're still doing this."
4. fixed external: pick up dumbbells (no dialogue)
5. fixed: shoulder press set + "That woke me up fast."
6. handheld walking + "Upper body done… and I'm already dying."
7. tight close-up: water bottle drink + "Best part of the workout."
8. fixed wider facing mirror: stretch + laugh + "A little stretch so I can pretend I'm disciplined."
9. handheld close selfie + flush + "I always say quick workout… and then stay forever."
10. arm's-length exit walk + wave + "Okay, I'm done. Good night."

## Cost estimate
- 10 scenes × 5 sec LTX-2 render = 50 sec output = ~30-60 min GPU time
- TTS: 10 lines × ~10 sec = 1-2 min (Edge TTS)
- Lipsync: 10 scenes × SadTalker ~30 sec = 5 min
- Composite + edit: 10-20 min
- **Total per ASIN: ~45-90 min GPU + 20 min CPU**

## Continuity rules (must enforce)
- Same woman in every shot (use the same avatar seed)
- Same outfit, same hair, same gym (single reference image)
- No duplicated limbs, broken hands, disappearing water bottle
- Jump cuts clean (no camera visible)

## Render queue
1. **Scene 1** (selfie walk intro) — uses avatar_01.jpg as start frame
2. **Scene 2** (room pan) — separate render with different camera instruction
3. ... all 10 scenes
4. Concat with FFmpeg
5. Add TTS audio
6. Color grade (DV tape look: muted contrast, slight blur, tape noise)

## Blockers
- RyZen no internet → FFmpeg binaries not auto-downloaded (journalctl error 13:21)
- Lip-sync model (SadTalker) not installed on RyZen
- TTS needs to run on Oleg (Edge TTS works offline)

## Files
- Avatar: `~/backend_repo/hermes-pinterest-deploy/avatars/avatar_01.jpg`
- Spec: this file
- Pipeline script: TODO write `gen_ugc_video.py --asin X`