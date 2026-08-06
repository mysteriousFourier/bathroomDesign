# AGEN-24 Point Marker Test Image

This directory stores only the metadata for the isolated real test image from AGEN-24. The image itself is retained outside Git.

Files:

- `manifest.json`: attachment metadata, checksum, dimensions, external-retention status, dedupe result, and testing policy.

Purpose:

- Keep the AGEN-24 test photo in authorized external test storage, independent from the repository.
- Provide a stable input for point-marker recognition, manual point dragging, non-rectangular boundary recovery, and dimension-chain closure regression tests.
- Use the manifest hash to verify that future OCR or vision runs use the same original pixels.

Validation entry point:

```bash
python scripts/benchmark_floorplan_fast.py --image <local-source.jpg>
```
