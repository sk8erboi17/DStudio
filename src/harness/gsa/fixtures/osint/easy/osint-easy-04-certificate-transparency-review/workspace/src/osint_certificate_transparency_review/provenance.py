from .models import SourceRecord

TRUSTED_SOURCES = {'ct-log', 'repo-index', 'package-index'}

def independent_source_count(records: list[SourceRecord]) -> int:
    return len({r.source for r in records if r.source in TRUSTED_SOURCES})

def ownership_ready(records: list[SourceRecord]) -> bool:
    if independent_source_count(records) < 2:
        return False
    return sum(1 for r in records if r.confidence == 'high') >= 1
