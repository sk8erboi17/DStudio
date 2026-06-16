---
name: rsa-structure-reconstruction
description: Reverse a public website into a durable STRUCTURE.MD map using evidence-backed sections, public observations, and explicit VERIFIED/INFERRED/UNKNOWN labels. Use for RSA runs that need to reconstruct product, frontend, API, content, data, and infrastructure structure from a website.
modes: [agent]
---

# RSA Structure Reconstruction

Use this skill during Reverse Structure Analysis when the primary artifact is `STRUCTURE.MD`.

## Contract

- Treat `STRUCTURE.MD` as the source of truth.
- If it does not exist, create it before writing findings.
- Preserve useful existing sections and append improvements instead of replacing the whole file.
- Every claim must be labeled `[VERIFIED]`, `[INFERRED]`, or `[UNKNOWN]`.
- Do not write a security verdict, marketing summary, or generic SaaS analysis.
- Do not rely on unstated patterns. If evidence is absent, write `[UNKNOWN]`.

## Workflow

1. Record the target URL and analysis scope.
2. Inventory public pages, navigation, metadata, forms, public requests, scripts, styles, media, storage/CDN domains, cookies, and local/session storage.
3. Convert observations into structure sections only when there is direct evidence.
4. Separate visible facts from architecture interpretation.
5. Update `STRUCTURE.MD` with section-level evidence and open questions.

## Section Shape

Each section should use this shape:

```markdown
## Section Name

### Purpose
What this section investigates.

### Findings
- [VERIFIED] ...
- [INFERRED] ...
- [UNKNOWN] ...

### Evidence
- URL/request/header/asset/UI observation: ...

### Structure Interpretation
What the evidence says about the product or system structure.

### Confidence
High / Medium / Low, with a short reason.

### Open Questions
- ...
```

## Quality Bar

- Prefer concrete URLs, request methods, response types, headers, asset filenames, and UI behavior.
- Avoid framework guesses from one weak marker.
- When multiple interpretations are possible, list the competing interpretations and mark them `[UNKNOWN]` or `[INFERRED]` with confidence.
