from network_security_dns_egress_review.engine import decide
from network_security_dns_egress_review.rules import Rule

def test_default_deny():
    assert decide([], "10.1.1.1", "192.0.2.5", 443) == "deny"
