---
name: rsa-product-system-model
description: Build a product/system model from public website evidence: entities, workflows, user roles, capabilities, plans, limits, and likely service boundaries for RSA.
modes: [agent]
---

# RSA Product System Model

Use this skill when the RSA goal is to understand what the product does and what backend services or data entities are implied by public behavior.

## Evidence To Capture

- Main navigation and page hierarchy.
- Signup/login/account gates.
- Pricing, limits, quotas, plan names, and entitlement wording.
- Search/discovery flows.
- Object pages, detail pages, profile pages, archive pages, and ID patterns.
- Public structured data such as JSON-LD and sitemap entries.

## Entity Mapping

For each likely entity, write:

- Fields directly visible.
- URLs/API responses that expose it.
- Relationships to other entities.
- Confidence: High / Medium / Low.

Mark private entities `[INFERRED]` or `[UNKNOWN]` unless public evidence exposes them.

## STRUCTURE.MD Targets

Update these sections when evidence exists:

- Product/Domain Model
- Data Model Inference
- Workflow Map
- Billing and Entitlements
- System Design Diagram
- Unknowns and Verification Plan
