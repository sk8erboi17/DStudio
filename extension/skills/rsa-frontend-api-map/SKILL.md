---
name: rsa-frontend-api-map
description: Map a public website's frontend stack, routing, client-side behavior, public API calls, request/response formats, storage, cookies, and third-party scripts for RSA reverse-structure analysis.
modes: [agent]
---

# RSA Frontend And API Map

Use this skill when an RSA run needs to understand how a public website is assembled and how its browser client talks to backend services.

## Evidence To Capture

- Initial HTML document and response headers.
- Script, stylesheet, manifest, preload, and module URLs.
- Framework/build markers only when directly visible.
- Public network requests triggered by normal navigation.
- Request method, path, query shape, status, content type, and response shape.
- Cookies, localStorage, sessionStorage, and consent/banner behavior.
- Public forms, search boxes, filters, login/signup redirects, and dashboard gates.

## Rules

- Do not infer a backend framework from frontend styling alone.
- Do not call private endpoints beyond normal page navigation.
- Do not brute force, fuzz, or scan.
- If an API requires auth, record the gate and mark response internals `[UNKNOWN]`.
- Distinguish SPA, SSR, static, and hybrid only from observed routing/hydration evidence.

## STRUCTURE.MD Targets

Update these sections when evidence exists:

- Frontend Architecture
- Frontend Technology Evidence
- Public API Surface
- Authentication and Account System
- Search and Discovery
- Infrastructure and Hosting Clues
