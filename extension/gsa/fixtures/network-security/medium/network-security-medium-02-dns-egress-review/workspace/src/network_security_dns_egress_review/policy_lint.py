from .rules import Rule

def overlapping_admin_rules(rules: list[Rule]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for i, left in enumerate(rules):
        for right in rules[i + 1:]:
            if left.port == right.port and left.dst == right.dst and left.action != right.action:
                out.append((left.rule_id, right.rule_id))
    return out

def temporary_window_requires_expiry(rule: Rule) -> bool:
    if 'window' not in rule.rule_id and rule.action != 'allow':
        return True
    return False
