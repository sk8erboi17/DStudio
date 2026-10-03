from osint_certificate_transparency_review.models import SourceRecord
from osint_certificate_transparency_review.merge import same_entity

def test_identical_values_merge():
    a = SourceRecord("repo", "2026-01-01", "domain", "api.example.test", "medium")
    b = SourceRecord("ct", "2026-01-02", "domain", "api.example.test", "high")
    assert same_entity(a, b)
