import csv
from .rules import Rule

def load_rules(path: str) -> list[Rule]:
    with open(path, newline="") as fh:
        return [Rule(row["rule_id"], row["src"], row["dst"], int(row["port"]), row["action"]) for row in csv.DictReader(fh)]
