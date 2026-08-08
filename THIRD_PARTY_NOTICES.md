# Third-Party Notices

## SPAI

The live screening fallback uses the official implementation and model weights
from **SPAI: Spectral AI-Generated Image Detector**.

- Source: https://github.com/kartyg23/spai
- Pinned revision: `b1b1422f2912594ba2620b311dde5d28a230d04c`
- License: Apache License 2.0
- Official checkpoint SHA-256: `24159f27d7c8c2cd0cb6c4019189eb89ad0874a0d9d15f8dc9afd39ca9648a55`
- Runtime safetensors SHA-256: `ac5caaa6457172c53e36acdf665051ff292d2c3906b3911c51ed5db6844c2f87`

The runtime artifact contains only the official checkpoint's model tensors and
non-executable provenance metadata. It is stored in a private deployment volume
and is not committed to this repository.

SPAI copyright notices and the Apache License remain with their respective
authors. ShareGuard's workflow, policy, evidence packaging, audit chain,
signing service, and user interface are separate components. The ShareGuard
private fusion model is not deployed in the current public service.
