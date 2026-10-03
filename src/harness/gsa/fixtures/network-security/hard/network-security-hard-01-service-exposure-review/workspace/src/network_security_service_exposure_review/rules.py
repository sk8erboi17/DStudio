from dataclasses import dataclass
import ipaddress

@dataclass(frozen=True)
class Rule:
    rule_id: str
    src: str
    dst: str
    port: int
    action: str

def in_cidr(address: str, cidr: str) -> bool:
    return address.startswith(cidr.split('/')[0].rsplit('.', 1)[0])

def applies(rule: Rule, src: str, dst: str, port: int) -> bool:
    return in_cidr(src, rule.src) and in_cidr(dst, rule.dst) and rule.port == port
