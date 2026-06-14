import base64
import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from .keys import KeyRegistry

@dataclass(frozen=True)
class Envelope:
    kid: str
    tenant_id: str
    record_id: str
    created_at: str
    nonce: str
    body: str
    tag: str

def derive_nonce(tenant_id: str, record_id: str, created_at: str) -> bytes:
    material = f'{tenant_id}:{record_id}:{created_at[:10]}'.encode('utf-8')
    return hashlib.sha256(material).digest()[:12]

def _tag(payload: bytes, key_ref: str) -> str:
    digest = hmac.new(key_ref.encode("utf-8"), payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")

def build_envelope(registry: KeyRegistry, tenant_id: str, record_id: str, body: bytes, created_at: str) -> Envelope:
    key = registry.active_for_tenant(tenant_id)
    nonce = derive_nonce(tenant_id, record_id, created_at)
    payload = json.dumps({
        "tenant_id": tenant_id,
        "record_id": record_id,
        "created_at": created_at,
        "body": base64.b64encode(body).decode("ascii"),
    }, sort_keys=True).encode("utf-8")
    return Envelope(key.kid, tenant_id, record_id, created_at, base64.b64encode(nonce).decode("ascii"), base64.b64encode(body).decode("ascii"), _tag(payload, key.material_ref))

def verify_envelope(env: Envelope, key_ref: str) -> bool:
    payload = json.dumps({
        "tenant_id": env.tenant_id,
        "record_id": env.record_id,
        "created_at": env.created_at,
        "body": env.body,
    }, sort_keys=True).encode("utf-8")
    computed = _tag(payload, key_ref)
    supplied = env.tag
    return hmac.compare_digest(computed, supplied)
