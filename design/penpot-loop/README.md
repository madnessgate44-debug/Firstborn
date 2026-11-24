# Penpot <-> token pipeline: bounded full-loop proof (2026-11-24)

Status: WORKING PROOF (bounded). Not a production design system.

## What was verified
1. Free Penpot account (design.penpot.app, GitHub OAuth, no card), team "Madness Gate", project "Design System".
2. Our placeholder tokens converted to DTCG (mg-tokens-penpot.json) and IMPORTED into Penpot: 27 tokens (12 color, 5 space, 4 radius, 4 font-size, 2 font-weight).
3. A 360x280 board styled with token reference mg-foundation.color.surface.raised + Arabic text layer (cloud-browser-20261124-174214.png).
4. Penpot token EXPORT captured (penpot-tokens-export.json).
5. Adapter (penpot export -> our tokens.json shape, tokens-from-penpot.json) -> real compile_tokens.py -> tokens-from-penpot.css: 34 --ds-* properties, values IDENTICAL to the pipeline's original tokens.css.
6. Render proof: the states page rendered with the Penpot-exported tokens (after-penpot-tokens-390.png LTR, after-penpot-tokens-rtl-390.png RTL Arabic) - all 5 states render correctly.

## Known gaps (not claimed)
- Penpot export uses Tokens Studio type names (fontSizes/fontWeights), wraps tokens in the set name, flattens weights to numbers. The adapter handles this mapping; it is ~30 lines and needs hardening.
- .penpot source file and SVG/PNG asset export not yet preserved here.
- Token applied to board fill only; text-layer token not applied.
- No themes/multi-set test yet.
- Token values remain UNAPPROVED PLACEHOLDER pending the Brand Foundation decisions.
