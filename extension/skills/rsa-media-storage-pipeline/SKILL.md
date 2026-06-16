---
name: rsa-media-storage-pipeline
description: Analyze public media, asset, download, playback, CDN, storage, and delivery clues during RSA runs, without guessing private infrastructure beyond evidence.
modes: [agent]
---

# RSA Media Storage Pipeline

Use this skill when the target has images, video, audio, downloads, generated artifacts, archives, or large static assets.

## Evidence To Capture

- Media URLs, subdomains, path patterns, extensions, and content types.
- Cache headers, range support, redirects, CDN headers, and signed/unsigned URL behavior.
- Player scripts, manifests, thumbnails, preview assets, and download controls.
- Public metadata such as JSON-LD, Open Graph media tags, file sizes, durations, or IDs.

## Interpretation Rules

- Object storage provider is `[UNKNOWN]` unless the domain, headers, or URL pattern directly identifies it.
- CDN provider is `[VERIFIED]` only when headers or DNS/public evidence identify it.
- Signed URL usage is `[INFERRED]` only when URLs contain expiring tokens/signatures or access behavior supports it.
- Retention and lifecycle are `[UNKNOWN]` unless visible product copy or API responses state them.

## STRUCTURE.MD Targets

Update these sections when evidence exists:

- Storage Architecture
- Playback and Download Pipeline
- VOD/Archive System or equivalent domain-specific archive section
- Scalability and Bottlenecks
- Unknowns and Verification Plan
