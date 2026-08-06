# AGEN-27 Dry/Wet Zone Real Sample

This directory preserves metadata for the bathroom plan used in AGEN-27 dry/wet zone and wall-finish flow checks. The uploaded image is retained outside Git.

Files:

- `manifest.json`: source attachment metadata, checksum, dimensions, external-retention status, and use policy.

Use this image as the default real uploaded sample for AGEN-27 regression checks that cover:

- manual point addition in the 2D plan;
- automatic dry/wet zone generation from drain points;
- manual dry/wet zone adjustment;
- point-to-wall binding;
- wall-finish generation for working finished surfaces.

Annotation rule: use the externally retained image as the base image. Automated or manual overlays may annotate recognized points, zones, walls, and finish surfaces, but must not replace the original uploaded image. Generated overlays are not committed.
