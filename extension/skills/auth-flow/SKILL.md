---
name: auth-flow
description: Authentication screens — sign in, sign up, reset, verify, SSO — that feel safe and frictionless, with real validation and every state rendered.
modes: [design]
when_to_use: The user wants login / sign-up / auth / onboarding-gate screens, or a "get started" account flow.
---

# SKILL: auth-flow

Auth is a trust moment and a friction point. Make it feel safe, fast, and obvious. Most of
the work is in the **states** — error, loading, success — not the happy form.

## The screens (build the set, not one)

- **Sign in**: email + password, "remember me", "forgot password?", a primary CTA, and
  **SSO buttons** (Google/GitHub/Apple) above or below a clear "or" divider. Link to sign up.
- **Sign up**: minimal fields (email + password, maybe name). Show a **password strength**
  meter + the rules. Terms/privacy line. SSO options. Link to sign in.
- **Forgot / reset**: request screen (email) → confirmation ("check your inbox") → new
  password screen. Each is its own state.
- **Verify**: a 6-digit code input (one box per digit, auto-advance) or magic-link sent.
- Optional: **2FA** prompt, **onboarding** first-run after success.

## Layout patterns

- **Centered card** on a clean/branded background (split-screen with a brand panel on the
  left + form on the right is the premium feel). Logo at top, one clear heading.
- Keep it to **one column, one obvious action**. No distractions, no nav.
- SSO buttons are visually distinct from the primary submit; equal width, real brand marks.

## Validation & states (the actual deliverable)

- **Inline validation**: per-field, on blur and on submit; the message sits under the field,
  the field gets an error treatment. Never a single generic "invalid" at the top only.
- **Loading**: submit button shows a spinner + disables (no double submit).
- **Error**: wrong credentials → a clear, non-leaky message ("email or password is
  incorrect"), not "user not found" (don't enumerate accounts).
- **Success**: brief confirmation before redirect, or the next step.
- **Empty/default**, **focus** (clear focus ring), **password show/hide** toggle, **caps-lock**
  hint if you can.

## Self-check before artifact (fix anything < 3/5)

- **Frictionless**: minimal fields, SSO offered, one obvious action?
- **States rendered**: error / loading / success / validation actually shown, not just the
  blank form?
- **Trust**: safe-feeling, no account enumeration, terms present where needed?
- **Reachability**: keyboard + autofill friendly, show/hide password?
- **Hierarchy**: primary submit vs SSO vs links clearly ranked?

Gate: contrast ≥4.5:1, inputs ≥44px tall, labels present (not placeholder-only), error
messages real and specific, single column at 390, no lorem.
