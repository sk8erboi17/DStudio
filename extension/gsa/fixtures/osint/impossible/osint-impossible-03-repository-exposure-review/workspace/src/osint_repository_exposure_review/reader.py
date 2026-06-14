import csv
from .models import SourceRecord

def load_records(path: str) -> list[SourceRecord]:
    with open(path, newline="") as fh:
        return [SourceRecord(row["source"], row["observed_at"], row["subject"], row["value"], row["confidence"]) for row in csv.DictReader(fh)]
