# ShareGuard Student Innovation Award Interview Deck Design

**Date:** 2026-08-09  
**Format:** 16:9 PPTX, Mandarin, ten-minute interview, live website demonstration permitted

## Objective

Build a ten-minute presentation that makes three points unmistakable:

1. Images entering real publication workflows have already been compressed,
   resized, captured, captioned, and repeatedly forwarded.
2. ShareGuard retains stronger detection performance across those transmission
   conditions than representative single-detector baselines.
3. ShareGuard converts detection into a complete institutional action: screen,
   decide, preserve, and independently verify.

The presentation is designed for innovation-award judges. Practical meaning is
the narrative spine; technical evidence proves the claim rather than replacing
it.

## Language Rules

All visible slide copy uses direct, affirmative statements. The deck excludes
defensive phrases such as “不是……而是……”, “辅助判断”, “不替代人工”, “仅供参考”,
and generic limitation language. Every technical statement ends in a concrete
effect on publication, review, evidence, or accountability.

Closing statement:

> 让高风险影像止步于发布前。  
> 让每一次公共传播，都有证据可查。

## Visual Direction

Use the ShareGuard decision-dossier system as the main visual language:

- warm-white evidence paper, black rules, risk red, verification green;
- full-bleed breaking-event photography for the opening and propagation chain;
- one assertion per slide, large Chinese headlines, restrained English labels;
- scientific plots appear on only two main-story slides;
- no decorative gradients, floating cards, oversized paragraphs, or generic
  technology imagery;
- motion is limited to ordered reveals needed for the live explanation.

The opening borrows the event-first direction. The evidence section borrows the
frozen-proof direction. All remaining slides use the decision-dossier direction.

## Ten-Minute Story

| Time | Slide | Core assertion |
| --- | --- | --- |
| 00:00–00:40 | 1. Opening | 一张被反复传播的影像，可以在核验完成前进入公共舆论。 |
| 00:40–01:25 | 2. Real gap | 真正的检测难题发生在压缩、缩放、截图、加字和转发之后。 |
| 01:25–02:10 | 3. ShareGuard | ShareGuard在发布前完成传播后检测、处置和证据锁定。 |
| 02:10–03:05 | 4. Technical advantage | 语义、结构、频域三类证据与双尺度十检查点共同抵抗传播失真。 |
| 03:05–03:55 | 5. Propagation image set | 同一事件图经过五种传播状态，仍由同一冻结规则处理。 |
| 03:55–04:35 | 6. Robustness evidence | ShareGuard在9/10条件领先SPAI，退化均值提高6.25 pp。 |
| 04:35–05:10 | 7. External confirmation | 5,000张untouched图像一次性确认跨来源与跨生成器能力。 |
| 05:10–07:20 | 8. Live demonstration | 导入、追加版本、处置、签封、验证在正式网站连续完成。 |
| 07:20–08:20 | 9. From score to action | 普通检测器输出分数；ShareGuard形成可执行、可追溯的发布案卷。 |
| 08:20–09:20 | 10. Practical meaning | 编辑部、平台和公共机构获得更早的拦截、更快的协作与完整的责任证据。 |
| 09:20–10:00 | 11. Close | 让高风险影像止步于发布前，让每一次公共传播都有证据可查。 |

Four hidden backup slides cover the full architecture, ten-condition table,
paired statistics, and protected deployment boundary.

## Technical Advantage Slide

The comparison is explicit and operational:

| Dimension | Typical image detector | ShareGuard |
| --- | --- | --- |
| Input assumption | Clean or lightly processed image | Ten real transmission conditions |
| Evidence | One dominant representation | Semantic + structural + 28-D frequency evidence |
| Stability | One model instance | CLIP-B/CLIP-L, five seeds each, frozen fusion |
| Validation | Aggregate benchmark score | Frozen threshold, paired testing, untouched holdout |
| Output | Image-level score | Risk, workflow action, encrypted custody, signed evidence |

Visible proof points:

- 0.8399 NoisyShareBench balanced accuracy;
- 0.9199 NoisyShareBench AUC;
- 0.7750 ten-condition mean, +6.25 pp over SPAI;
- 9 of 10 transmission conditions ahead of SPAI;
- JPEG Q10 +19.14 pp and share-heavy +12.97 pp over SPAI;
- 5,000-image untouched confirmation: 0.8008 bAcc, 0.9077 AUC,
  0.9017 AP, 93.36% generated-image recall.

## Practical Meaning Slide

Each audience receives one concrete change:

- **Newsroom:** suspicious media reaches a structured review desk before
  publication; original-material requests and decisions stay in one case.
- **Content platform:** propagated versions, assignments, escalation, and audit
  events share one workflow and one evidence format.
- **Public institution:** media hash, decision record, signature, and portable
  `.sgd` package support independent verification and later review.

The central visible sentence is:

> 普通AI检测停在一个分数；ShareGuard把分数变成发布行动。

## Live Demonstration

Use one prepared synthetic event image and one deterministic transmission
variant that have both been tested before the interview. The demonstration
sequence is:

1. import the event image;
2. show the returned image-level score and recommendation;
3. append the propagated version and compare the two uploaded files;
4. record a structured human disposition;
5. seal the case into `.sgd`;
6. open the verifier and show integrity success.

The main demonstration slide also contains four static fallback frames, so the
story remains continuous if the network or inference service is slow.

## Propagation-Robustness Image Set

Deliver six 16:9 or 4:3 high-resolution images based on one fictional breaking
event scene:

1. source-quality image;
2. JPEG Q10 recompression;
3. 256-pixel downscale and re-upload;
4. screenshot-like capture with browser or phone UI boundary;
5. share-heavy multi-generation compression;
6. meme-like news caption composition.

Every image keeps the same underlying event content. Labels state the applied
transmission operation and avoid implying that the image is an authentic news
record.

## Deliverables

- editable `.pptx` with speaker notes for every slide;
- PDF presentation fallback;
- rendered slide montage and individual slide previews;
- six propagation-robustness demonstration images;
- a one-page timing script with the live-demo click sequence;
- four hidden judge-question backup slides.

## Quality Gates

- total spoken script fits 9:30–10:00 at a natural Mandarin pace;
- no slide contains more than one principal assertion;
- all benchmark numbers match the frozen project record;
- every slide is rendered and inspected for overflow, overlap, stretching, and
  unreadable labels;
- propagation images preserve aspect ratio and underlying event identity;
- live-demo and fallback sequence are rehearsable from the same slide.
