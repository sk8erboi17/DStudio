---
name: login-flow
description: Mobile login and authentication flow screens
od:
  mode: prototype
  platform: mobile
triggers:
  - login
  - sign in
  - 注册登录
  - 登录注册
  - 手机号登录
  - 验证码登录
  - 密码登录
ds4_category: web-ui-prototype
ds4_local_mode: native
ds4_output_kinds: html
ds4_upstream: open-design/login-flow
ds4_modified_notice: Adapted for DStudio/DS4; added ds4_* metadata and local-first blueprint classification where needed.
ds4_source_repo: https://github.com/nexu-io/open-design
ds4_source_ref: main
ds4_source_commit: 618a07d8db3a0e75e6d0e49f99a6eb9048f57036
---
# Login Flow Skill

A skill for generating mobile-first login and authentication screens. Use this when the user wants a sign-in experience for a mobile app, including phone + SMS verification, password-based login, and social SSO options.

## Workflow

1. **Read reference files first** (see below)
2. **Clarify auth method**: phone/SMS, password, or social SSO
3. **Checklist gate** — verify P0 items before emitting `<artifact>`
4. **Build the HTML prototype** with proper states (default, loading, error)
5. **Wrap in `<artifact>` tag** referencing the output file

## Side Files

- `references/checklist.md` — P0/P1 acceptance criteria

## Output

A single standalone HTML file implementing the login screen with:
- Labels above inputs (never placeholder-only)
- Password field with show/hide toggle
- Social SSO buttons with SVG icons
- Error states below fields
- Loading spinner in primary CTA
- Touch targets minimum 44px

## Mobile-First Constraints

- Viewport: 375px wide (iPhone standard)
- No horizontal scroll
- Safe area insets for notched devices
- Input keyboards: `tel` for phone, `password` for password fields
