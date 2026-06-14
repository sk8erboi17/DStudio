from .rules import Rule, applies

def decide(rules: list[Rule], src: str, dst: str, port: int) -> str:
    matches = [rule for rule in rules if applies(rule, src, dst, port)]
    return 'deny' if any(rule.action == 'deny' for rule in matches) else (matches[-1].action if matches else 'deny')
