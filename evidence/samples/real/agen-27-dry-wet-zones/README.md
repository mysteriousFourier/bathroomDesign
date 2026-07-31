# AGEN-27 Dry/Wet Zone Real Sample

This directory persists the uploaded bathroom plan image used for AGEN-27 dry/wet zone and wall-finish flow checks.

Files:

- `source.jpg`: stable original image copied from the AGEN-27 issue attachment `test0.jpg`.
- `manifest.json`: source attachment metadata, checksum, dimensions, and use policy.

Use this image as the default real uploaded sample for AGEN-27 regression checks that cover:

- manual point addition in the 2D plan;
- automatic dry/wet zone generation from drain points;
- manual dry/wet zone adjustment;
- point-to-wall binding;
- wall-finish generation for working finished surfaces.

Annotation rule: use `source.jpg` as the base image. Automated or manual overlays may annotate recognized points, zones, walls, and finish surfaces, but must not replace the original uploaded image.
