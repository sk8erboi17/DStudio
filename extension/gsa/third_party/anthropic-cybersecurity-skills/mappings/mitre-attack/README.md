# MITRE ATT&CK Mapping

This directory maps the cybersecurity skills in this repository to the [MITRE ATT&CK](https://attack.mitre.org/) framework (Enterprise v15).

## Overview

MITRE ATT&CK is a curated knowledge base and model for cyber adversary behavior, reflecting the various phases of an adversary's lifecycle and the platforms they target. This mapping connects our hands-on skills to ATT&CK tactics and techniques, enabling:

- **Threat-informed defense** -- prioritize skill development based on real adversary behavior
- **Gap analysis** -- identify ATT&CK techniques not yet covered by available skills
- **Purple team exercises** -- pair offensive (red team) and defensive (blue team) skills for each technique
- **Agent-driven discovery** -- AI agents can query skills by ATT&CK ID for automated security workflows

## Mapping Methodology

### Tactic Mapping (TA00xx)

Each of the 14 ATT&CK Enterprise tactics represents a distinct adversary objective. Skills are mapped to tactics based on which adversary goal they help achieve (offensive) or defend against (defensive):

| Tactic | ID | Offensive Skills | Defensive Skills |
|--------|-----|-----------------|------------------|
| Reconnaissance | TA0043 | penetration-testing, red-teaming | threat-intelligence, phishing-defense |
| Resource Development | TA0042 | red-teaming | threat-intelligence |
| Initial Access | TA0001 | web-application-security, penetration-testing | phishing-defense, endpoint-security |
| Execution | TA0002 | penetration-testing, red-teaming | malware-analysis, endpoint-security, soc-operations |
| Persistence | TA0003 | red-teaming, penetration-testing | threat-hunting, digital-forensics, endpoint-security |
| Privilege Escalation | TA0004 | penetration-testing, red-teaming | endpoint-security, identity-access-management |
| Defense Evasion | TA0005 | red-teaming | malware-analysis, endpoint-security, threat-hunting |
| Credential Access | TA0006 | penetration-testing, red-teaming | identity-access-management, soc-operations |
| Discovery | TA0007 | penetration-testing, red-teaming | threat-hunting, network-security |
| Lateral Movement | TA0008 | red-teaming, penetration-testing | network-security, threat-hunting, soc-operations |
| Collection | TA0009 | red-teaming | digital-forensics, threat-hunting |
| Command and Control | TA0011 | red-teaming | threat-intelligence, network-security, soc-operations |
| Exfiltration | TA0010 | red-teaming | threat-hunting, digital-forensics, network-security |
| Impact | TA0040 | red-teaming | ransomware-defense, incident-response |

### Technique Mapping (T1xxx)

Skills are mapped to specific techniques based on their content. Examples:

| Technique | ID | Example Skills |
|-----------|-----|---------------|
| Phishing | T1566 | analyzing-phishing-email-headers, analyzing-certificate-transparency-for-phishing |
| Exploit Public-Facing Application | T1190 | web-application-security skills (SQL injection, XSS, SSRF) |
| OS Credential Dumping | T1003 | penetration-testing credential harvesting skills |
| PowerShell | T1059.001 | analyzing-windows-event-logs-in-splunk, malware-analysis skills |
| Remote Services | T1021 | network-security lateral movement skills |
| Data Encrypted for Impact | T1486 | analyzing-ransomware-encryption-mechanisms |
| Command and Scripting Interpreter | T1059 | malware-analysis script deobfuscation skills |
| Scheduled Task/Job | T1053 | analyzing-malware-persistence-with-autoruns |
| Registry Run Keys | T1547.001 | analyzing-windows-registry-for-artifacts |
| DLL Side-Loading | T1574.002 | analyzing-bootkit-and-rootkit-samples |

### Sub-technique Mapping (T1xxx.xxx)

Where applicable, skills are mapped to sub-techniques for precision. For example:

- `T1566.001` (Spearphishing Attachment) -- analyzing-email-headers-for-phishing-investigation
- `T1566.002` (Spearphishing Link) -- analyzing-certificate-transparency-for-phishing
- `T1003.001` (LSASS Memory) -- analyzing-memory-dumps-with-volatility

## ATT&CK Navigator Integration

You can visualize our skill coverage using the [ATT&CK Navigator](https://mitre-attack.github.io/attack-navigator/). To generate a Navigator layer:

1. Use the coverage summary in [`coverage-summary.md`](coverage-summary.md) to identify covered tactics
2. Import the tactic/technique IDs into a Navigator layer JSON
3. Color-code by coverage depth (number of skills per technique)

### Suggested Color Scale

| Coverage | Color | Meaning |
|----------|-------|---------|
| 0 skills | White | No coverage -- gap |
| 1-2 skills | Light blue | Basic coverage |
| 3-5 skills | Medium blue | Moderate coverage |
| 6+ skills | Dark blue | Strong coverage |

## Skill Tag Convention

Skills relevant to ATT&CK carry these tags in their YAML frontmatter:

- `mitre-attack` -- general ATT&CK relevance (56 skills currently tagged)
- Technique-specific tags like `privilege-escalation`, `lateral-movement`, `persistence`
- Tool-specific tags that map to ATT&CK software entries (e.g., `cobalt-strike`, `mimikatz`)

## How to Contribute Mappings

1. **Identify the skill** -- Read the skill's SKILL.md to understand what it teaches
2. **Find the ATT&CK technique** -- Search [attack.mitre.org](https://attack.mitre.org/) for the matching technique
3. **Determine offensive vs. defensive** -- Is the skill about performing or detecting/preventing the technique?
4. **Update the mapping** -- Add the technique ID to the appropriate table in this directory
5. **Update skill tags** -- Add `mitre-attack` and technique-specific tags to the skill's frontmatter
6. **Submit a PR** -- Include the ATT&CK technique URL as justification

## References

- [MITRE ATT&CK Enterprise Matrix](https://attack.mitre.org/matrices/enterprise/)
- [MITRE ATT&CK Navigator](https://mitre-attack.github.io/attack-navigator/)
- [ATT&CK v15 Release Notes](https://attack.mitre.org/resources/updates/)
- [MITRE ATT&CK for ICS](https://attack.mitre.org/matrices/ics/) -- relevant for ot-ics-security skills
- [MITRE ATT&CK for Mobile](https://attack.mitre.org/matrices/mobile/) -- relevant for mobile-security skills
