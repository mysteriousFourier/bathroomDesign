# AGEN-24 Point Marker Test Image

This directory stores the isolated real test image from AGEN-24.

Files:

- `source.jpg`: stable original copy of `test0.jpg` from the issue attachment.
- `manifest.json`: attachment metadata, checksum, dimensions, dedupe result, and testing policy.

Purpose:

- Keep the AGEN-24 test photo independent from screenshots, dependency images, and other real samples.
- Provide a stable input for point-marker recognition, manual point dragging, non-rectangular boundary recovery, and dimension-chain closure regression tests.
- Preserve the original pixels so future OCR or vision output can be compared against the same source image.

Validation entry point:

```bash
python scripts/benchmark_floorplan_fast.py --image evidence/samples/real/agen-24-point-marker-test/source.jpg
```
