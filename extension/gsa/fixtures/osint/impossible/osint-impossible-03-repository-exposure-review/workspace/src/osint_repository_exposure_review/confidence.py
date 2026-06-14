SCORES = {"low": 1, "medium": 2, "high": 3}

def group_score(confidences: list[str]) -> int:
    return sum(SCORES.get(item, 0) for item in confidences)
