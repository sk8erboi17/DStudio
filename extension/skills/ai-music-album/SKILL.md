---
name: ai-music-album
description: |
  Full-lifecycle AI music album production — concept, lyric drafting, track sequencing, and export. Useful for indie album experiments and brand soundtracks.
triggers:
  - "ai music"
  - "music album"
  - "lyric writing"
  - "track sequencing"
  - "album production"
od:
  mode: audio
  category: audio-music
  upstream: "https://github.com/bitwize-music-studio/claude-ai-music-skills"
ds4_category: media-blueprint
ds4_local_mode: reference
ds4_output_kinds: audio-script
ds4_upstream: open-design/ai-music-album
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# ai-music-album

> Curated from bitwize-music-studio.

## What it does

Full-lifecycle AI music album production — concept, lyric drafting, track sequencing, and export. Useful for indie album experiments and brand soundtracks.

## Source

- Upstream: https://github.com/bitwize-music-studio/claude-ai-music-skills
- Category: `audio-music`

## How to use

This catalogue entry advertises the skill in Open Design so the agent
discovers it during planning. To run the full upstream workflow with
its original assets, scripts, and references, install the upstream
bundle into your active agent's skills directory:

```bash
# Inspect the upstream README for exact paths
open https://github.com/bitwize-music-studio/claude-ai-music-skills
```

Then ask the agent to invoke this skill by name (`ai-music-album`) or with
one of the trigger phrases listed in this skill's frontmatter.
