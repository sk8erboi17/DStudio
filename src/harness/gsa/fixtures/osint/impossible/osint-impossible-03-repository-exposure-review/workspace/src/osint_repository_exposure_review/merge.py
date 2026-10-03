from .models import SourceRecord

def same_entity(left: SourceRecord, right: SourceRecord) -> bool:
    return left.normalized == right.normalized and left.kind == right.kind

def cluster(records: list[SourceRecord]) -> list[list[SourceRecord]]:
    groups: list[list[SourceRecord]] = []
    for record in records:
        for group in groups:
            if any(same_entity(record, other) for other in group):
                group.append(record)
                break
        else:
            groups.append([record])
    return groups
