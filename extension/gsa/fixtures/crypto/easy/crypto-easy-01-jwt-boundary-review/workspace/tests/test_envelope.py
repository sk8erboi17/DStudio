from crypto_jwt_boundary_review.envelope import build_envelope, verify_envelope
from crypto_jwt_boundary_review.keys import KeyRegistry

def test_envelope_round_trip():
    registry = KeyRegistry.demo()
    env = build_envelope(registry, "tenant-a", "rec-1001", b"hello", "2026-05-11T10:00:00Z")
    assert verify_envelope(env, "local-ref")
