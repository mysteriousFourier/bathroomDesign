# AGEN-17 Long-Term Real Sample

This directory preserves metadata and replay evidence for the AGEN-17 hand-drawn floorplan. The source image is retained in authorized external test storage and is not committed to Git.

Source-platform identifiers and location-specific OCR text are redacted in the tracked metadata and replay JSON.

Files:

- `manifest.json`: source attachment metadata, checksum, dimensions, retention policy, and annotation policy.
- `recognized-plan.json`: OCR evidence and the last successful dimension-chain reconstruction.

The AGEN-6.4 diagnostic can run fresh OCR or deterministically replay the saved
evidence. Generated masks and previews are written below `.tmp/`:

```bash
python scripts/recognize_floorplan_sample.py --image <local-source.jpg>
python scripts/recognize_floorplan_sample.py --image <local-source.jpg> --replay-json evidence/samples/real/agen-17-long-term/recognized-plan.json
```

Fresh PaddleOCR output is not deterministic. The script fails closed when a
critical handwritten dimension such as `615` or the `800` door width is absent;
use replay mode when validating the reconstruction logic itself.

Annotation rule: use the externally retained source image as the base image. OCR or manual annotation should only cover the handwritten text bbox that was recognized, and must not redraw walls, dimension lines, or room topology. Generated masks and previews stay under `.tmp/`.
