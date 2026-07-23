# AGEN-17 Long-Term Real Sample

This directory persists the real hand-drawn floorplan image requested in AGEN-17 as a long-term regression sample.

Files:

- `source.jpg`: stable original image copy from the issue attachment.
- `manifest.json`: source attachment metadata, checksum, dimensions, and annotation policy.

Annotation rule: use `source.jpg` as the base image. OCR or manual annotation should only cover the handwritten text bbox that was recognized, and must not redraw walls, dimension lines, or room topology.
