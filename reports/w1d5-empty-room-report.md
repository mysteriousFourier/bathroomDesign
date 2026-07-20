# W1D5 Empty-Room 3D and Annotation Report

Status: unverified. Business thresholds and customer-facing vocabulary remain pending_business_confirmation.

## Inputs

- Measurement: `evidence/samples/synthetic/measurement-synthetic-005-full-featured.json`
- Fixture placement: `evidence/samples/placements/fixture-placement-synthetic-005-toilet.json`
- W1D3 geometry: `contracts/geometry/w1d3-recovery-golden.json`
- W1D4 topology: `contracts/topology/w1d4-topology-golden.json`
- Evidence: `EV-009`, `EV-010`, `EV-011`

## Outputs

- Scene JSON: `contracts/3d/empty-room-scene.json`
- Annotation JSON: `contracts/annotation/measurement-synthetic-005-annotation.json`
- Three.js viewer: `viewer/w1d5-empty-room-viewer.html`
- Desktop screenshot artifact: `reports/screenshots/w1d5-empty-room-desktop.svg`
- Mobile screenshot artifact: `reports/screenshots/w1d5-empty-room-mobile.svg`
- Desktop browser screenshot: `reports/screenshots/w1d5-empty-room-desktop.png`
- Mobile browser screenshot: `reports/screenshots/w1d5-empty-room-mobile.png`

## Height Fields

| field | value | status |
|---|---:|---|
| roomHeight | 2400 mm | unverified |
| wallHeight | 2800 mm | unverified |
| groundElevation | 0 mm | unverified |
| netHeight | 2400 mm | provisional |
| doorOpeningHeight | opening.height fallback | provisional |

## Traceability

- Scene primitives: 11; every primitive carries `id`, `source`, `evidenceId`, and `status`.
- Annotation rows: 14; every annotation carries `id`, `source`, `evidenceId`, and `status`.
- Point labels include opening centers, drain coordinates, pipe-enclosure position, and synthetic fixture placement. No real products, prices, or site media are used.
- Only the allowed height fields are emitted: `roomHeight`, `wallHeight`, `groundElevation`, `netHeight`, and `doorOpeningHeight`.

## Interaction Contract

The viewer uses Three.js OrbitControls for rotate, pan, and zoom. It consumes the generated scene JSON and does not modify base geometry between schemes.
