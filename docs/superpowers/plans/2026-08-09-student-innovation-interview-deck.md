# ShareGuard Student Innovation Interview Deck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a polished ten-minute Mandarin PPTX for the HKICT Awards 2026 Student Innovation interview, including an event-consultation story, current frozen research evidence, a live-demo fallback, propagation-robustness images, speaker notes, PDF, previews, and QA records.

**Architecture:** A small Python content module is the single source of truth for slide copy, timings, notes, metrics, and terminology. Separate Python scripts prepare deterministic image variants, capture the public website, build the editable PPTX, and audit the package. PowerPoint COM is used only after generation to export PDF and rendered PNG previews, and is always closed by the export script.

**Tech Stack:** Python 3.11, python-pptx 1.0.2, Pillow 12.2, matplotlib 3.10, Playwright Python, PowerShell, Microsoft PowerPoint 16.

## Global Constraints

- Format is 16:9, simplified Chinese, with 11 visible slides and 4 hidden backup slides.
- Main story is C-end event consultation for many repeatedly propagated images from one event.
- Main model claim is all nine held-out propagation operations lead the evaluated baselines: SPAI, AIDE, UnivFD, and FatFormer.
- Keep the propagation-matrix protocol separate from the 5,000-image untouched protocol.
- Use direct outcome language; forbid `不是……而是……`, `辅助判断`, `不替代人工`, `仅供参考`, and generic defensive wording.
- Use warm-white evidence paper, black rules, risk red, and verification green; no decorative gradients, floating-card dashboard, or repeated equal-card layout.
- Preserve image aspect ratio and never crop scientific labels or chart axes.
- Use a fictional simulated event image, clearly labeled `模拟事件影像`.
- Live demonstration must have static fallback frames on the same slide.
- Generate a real editable PPTX with useful notes on every visible slide.

---

### Task 1: Freeze Content, Terminology, And Timing

**Files:**
- Create: `outputs/shareguard_interview_2026/src/deck_content.py`
- Create: `outputs/shareguard_interview_2026/src/test_deck_content.py`
- Create: `outputs/shareguard_interview_2026/terminology_ledger.md`
- Create: `outputs/shareguard_interview_2026/speaker_script_cn.md`

**Interfaces:**
- Produces: `SLIDES`, `BACKUP_SLIDES`, `METRICS`, `BASELINES`, `FORBIDDEN_PHRASES`, `TOTAL_SECONDS`, and `assert_content_contract()`.
- Consumes: the approved design specification and frozen values `0.928679`, `0.980093`, `0.897556`, `+16.76`, `+20.04`, `+21.78`, and `+29.28` percentage points.

- [ ] Write tests requiring exactly 11 visible slides, 4 backup slides, 600 total seconds, non-empty speaker notes, all four baseline names, and zero forbidden phrases.
- [ ] Run `python -m unittest -v src/test_deck_content.py` and verify the missing content module fails.
- [ ] Implement the full slide copy, timing, notes, metric scopes, and canonical terminology.
- [ ] Generate the terminology ledger and speaker script from the same content data.
- [ ] Run the content tests and require all tests to pass.

### Task 2: Prepare The Event Propagation Asset Set

**Files:**
- Create: `outputs/shareguard_interview_2026/src/prepare_assets.py`
- Create: `outputs/shareguard_interview_2026/src/test_prepare_assets.py`
- Create: `outputs/shareguard_interview_2026/assets/propagation/source.png`
- Create: `outputs/shareguard_interview_2026/assets/propagation/jpeg_q75.jpg`
- Create: `outputs/shareguard_interview_2026/assets/propagation/jpeg_q50.jpg`
- Create: `outputs/shareguard_interview_2026/assets/propagation/jpeg_q30.jpg`
- Create: `outputs/shareguard_interview_2026/assets/propagation/jpeg_q10.jpg`
- Create: `outputs/shareguard_interview_2026/assets/propagation/resize_384.jpg`
- Create: `outputs/shareguard_interview_2026/assets/propagation/resize_256.jpg`
- Create: `outputs/shareguard_interview_2026/assets/propagation/share_heavy.jpg`
- Create: `outputs/shareguard_interview_2026/assets/propagation/screenshot_like.png`
- Create: `outputs/shareguard_interview_2026/assets/propagation/meme_like_v2.png`
- Create: `outputs/shareguard_interview_2026/assets/propagation/contact_sheet.png`

**Interfaces:**
- Consumes: one generated 16:9 fictional breaking-event source image.
- Produces: `build_propagation_assets(source_path, output_dir) -> dict[str, Path]` with deterministic transforms and a manifest recording dimensions, JPEG quality, and iteration count.

- [ ] Write tests for the exact ten filenames, stable dimensions, source-image identity, smaller Q10 file size than Q75, 384/256 short-side limits, and readable contact-sheet labels.
- [ ] Run the focused tests and verify they fail before implementation.
- [ ] Implement deterministic recompression, resizing, multi-generation sharing, screenshot framing, and caption composition with Pillow.
- [ ] Build and inspect the contact sheet; adjust crops or labels before slide use.
- [ ] Run the asset tests and require all tests to pass.

### Task 3: Capture The Formal Product Workflow

**Files:**
- Create: `outputs/shareguard_interview_2026/src/capture_site.py`
- Create: `outputs/shareguard_interview_2026/assets/site/home.png`
- Create: `outputs/shareguard_interview_2026/assets/site/current_case.png`
- Create: `outputs/shareguard_interview_2026/assets/site/verifier.png`
- Create: `outputs/shareguard_interview_2026/assets/site/capture_manifest.json`

**Interfaces:**
- Consumes: `https://shareguard.systems/` and the public routes available from its navigation.
- Produces: three 1440x900 PNG screenshots with browser chrome excluded and page readiness recorded.

- [ ] Implement a headless Playwright capture with a 30-second readiness limit and deterministic viewport.
- [ ] Capture the home/current-case/verifier states when routable; use existing verified product screenshots only when a route requires private state.
- [ ] Check each image is nonblank, at least 1200 pixels wide, and contains the ShareGuard visual field.
- [ ] Record URL, timestamp, viewport, and fallback source in the manifest.

### Task 4: Build The Editable PPTX

**Files:**
- Create: `outputs/shareguard_interview_2026/src/build_deck.py`
- Create: `outputs/shareguard_interview_2026/src/test_build_deck.py`
- Create: `outputs/shareguard_interview_2026/ShareGuard_Student_Innovation_Interview_2026.pptx`
- Create: `outputs/shareguard_interview_2026/asset_manifest.md`

**Interfaces:**
- Consumes: `deck_content.py`, propagation assets, website captures, and approved visual direction assets.
- Produces: `build_deck(output_path) -> Path` with 15 slides, notes, hidden backup slides, native charts/tables, and consistent slide metadata.

- [ ] Write structural tests for 15 slides, 11 visible slides, 4 hidden slides, notes on all visible slides, minimum embedded-media count, no placeholder text, and all shape bounds within 13.333x7.5 inches.
- [ ] Run the focused test and verify it fails before implementation.
- [ ] Implement reusable geometry, typography, image-crop, chart, source-strip, and notes helpers.
- [ ] Build 11 varied main-story compositions and 4 compact backup slides.
- [ ] Add native charts for the nine-operation leadership and four-baseline untouched gains.
- [ ] Run structural tests and fix every failure before rendering.

### Task 5: Export, Inspect, Correct, And Deliver

**Files:**
- Create: `outputs/shareguard_interview_2026/src/export_with_powerpoint.ps1`
- Create: `outputs/shareguard_interview_2026/src/audit_deck.py`
- Create: `outputs/shareguard_interview_2026/ShareGuard_Student_Innovation_Interview_2026.pdf`
- Create: `outputs/shareguard_interview_2026/rendered/slide-01.png` through `slide-15.png`
- Create: `outputs/shareguard_interview_2026/rendered/montage.png`
- Create: `outputs/shareguard_interview_2026/live_demo_click_sheet.md`
- Create: `outputs/shareguard_interview_2026/qa_report.md`

**Interfaces:**
- Consumes: the generated PPTX.
- Produces: rendered previews, PDF, montage, click sheet, severity-graded QA report, and final verification summary.

- [ ] Export PDF and PNGs through a hidden PowerPoint COM instance and close the application in `finally`.
- [ ] Generate a readable montage from rendered slides.
- [ ] Audit slide count, hidden status, notes, media, bounds, text density, repeated layouts, and forbidden phrases.
- [ ] Inspect the montage and key slides for overlap, clipping, image stretching, tiny labels, and weak composition.
- [ ] Record high/medium/low defects, fix every high and reasonable medium defect, regenerate, and repeat export/audit.
- [ ] Reopen the final PPTX, verify PDF and rendered outputs exist, and write the final QA report.

## Self-Review

- Spec coverage: all design sections map to Tasks 1-5, including C-end positioning, nine-operation evidence, multi-baseline statistics, live demo, ten image variants, notes, hidden backup slides, PDF, previews, and QA.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation step remains.
- Type consistency: `deck_content.py` is the sole content source; asset scripts return path mappings consumed by `build_deck.py`; `audit_deck.py` consumes only the final PPTX and rendered directory.
