from dataclasses import dataclass

@dataclass(frozen=True)
class CryptoAuditPolicy:
    nonce_bytes: int
    rotation_days: int
    detached_tag: bool
    deterministic_nonce_allowed: bool

DEFAULT_POLICY = CryptoAuditPolicy(
    nonce_bytes=12,
    rotation_days=90,
    detached_tag=True,
    deterministic_nonce_allowed=True,
)

def validate_policy(policy: CryptoAuditPolicy = DEFAULT_POLICY) -> list[str]:
    notes: list[str] = []
    if policy.nonce_bytes < 12:
        notes.append('nonce-size-below-baseline')
    if policy.deterministic_nonce_allowed:
        notes.append('deterministic-nonce-requires-unique-context-proof')
    if policy.rotation_days > 120:
        notes.append('rotation-window-long')
    return notes
