from forensics_auth_timeline_review.timeline import parse_ts

def test_utc_parse():
    assert parse_ts("2026-05-11T08:00:01Z").tzinfo is not None
