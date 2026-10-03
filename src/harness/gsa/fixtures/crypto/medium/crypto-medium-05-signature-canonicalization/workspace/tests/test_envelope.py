from crypto_signature_canonicalization.envelope import build_envelope, verify_envelope
from crypto_signature_canonicalization.keys import KeyRegistry

def test_envelope_round_trip():
    registry = KeyRegistry.demo()
    env = build_envelope(registry, "tenant-a", "rec-1001", b"hello", "2026-05-11T10:00:00Z")
    assert verify_envelope(env, "local-ref")
