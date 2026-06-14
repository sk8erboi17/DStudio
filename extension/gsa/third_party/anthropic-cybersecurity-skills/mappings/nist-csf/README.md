# NIST Cybersecurity Framework 2.0 Mapping

This directory maps the cybersecurity skills in this repository to the [NIST Cybersecurity Framework (CSF) 2.0](https://www.nist.gov/cyberframework), published February 2024.

## Overview

NIST CSF 2.0 organizes cybersecurity activities into 6 core functions that represent the full lifecycle of managing cybersecurity risk. This mapping enables organizations to:

- **Align skill development** to their CSF implementation tier
- **Identify training gaps** across the CSF functions
- **Build role-based learning paths** using CSF categories
- **Automate compliance mapping** through AI agent queries

## CSF 2.0 Functions and Skill Alignment

### Govern (GV) -- Cybersecurity Risk Management Strategy

Establishing and monitoring the organization's cybersecurity risk management strategy, expectations, and policy.

| Category | ID | Mapped Subdomains | Skills |
|----------|-----|-------------------|--------|
| Organizational Context | GV.OC | compliance-governance | 5 |
| Risk Management Strategy | GV.RM | compliance-governance, vulnerability-management | 29 |
| Roles, Responsibilities, and Authorities | GV.RR | compliance-governance, identity-access-management | 38 |
| Policy | GV.PO | compliance-governance, zero-trust-architecture | 18 |
| Oversight | GV.OV | compliance-governance, soc-operations | 38 |
| Cybersecurity Supply Chain Risk Management | GV.SC | devsecops, container-security | 42 |

**Primary subdomains:** compliance-governance (5), identity-access-management (33), devsecops (16)

### Identify (ID) -- Understanding Organizational Cybersecurity Risk

Understanding the organization's current cybersecurity risks.

| Category | ID | Mapped Subdomains | Skills |
|----------|-----|-------------------|--------|
| Asset Management | ID.AM | cloud-security, container-security, network-security | 107 |
| Risk Assessment | ID.RA | vulnerability-management, threat-intelligence | 67 |
| Improvement | ID.IM | soc-operations, compliance-governance | 38 |

**Primary subdomains:** vulnerability-management (24), threat-intelligence (43), cloud-security (48)

### Protect (PR) -- Safeguarding Assets

Using safeguards to prevent or reduce cybersecurity risk.

| Category | ID | Mapped Subdomains | Skills |
|----------|-----|-------------------|--------|
| Identity Management, Authentication, and Access Control | PR.AA | identity-access-management, zero-trust-architecture | 46 |
| Awareness and Training | PR.AT | phishing-defense, compliance-governance | 21 |
| Data Security | PR.DS | cryptography, cloud-security, api-security | 89 |
| Platform Security | PR.PS | endpoint-security, container-security, devsecops | 58 |
| Technology Infrastructure Resilience | PR.IR | network-security, zero-trust-architecture | 46 |

**Primary subdomains:** zero-trust-architecture (13), devsecops (16), identity-access-management (33), cryptography (13)

### Detect (DE) -- Finding and Analyzing Cybersecurity Events

Finding and analyzing possible cybersecurity compromises and anomalies.

| Category | ID | Mapped Subdomains | Skills |
|----------|-----|-------------------|--------|
| Continuous Monitoring | DE.CM | soc-operations, threat-hunting, network-security | 101 |
| Adverse Event Analysis | DE.AE | threat-hunting, malware-analysis, soc-operations | 102 |

**Primary subdomains:** threat-hunting (35), soc-operations (33), malware-analysis (34)

### Respond (RS) -- Taking Action Regarding Detected Incidents

Managing and responding to detected cybersecurity incidents.

| Category | ID | Mapped Subdomains | Skills |
|----------|-----|-------------------|--------|
| Incident Management | RS.MA | incident-response, soc-operations | 57 |
| Incident Analysis | RS.AN | digital-forensics, malware-analysis, threat-intelligence | 111 |
| Incident Response Reporting and Communication | RS.CO | incident-response, compliance-governance | 29 |
| Incident Mitigation | RS.MI | incident-response, endpoint-security, network-security | 73 |

**Primary subdomains:** incident-response (24), digital-forensics (34), malware-analysis (34)

### Recover (RC) -- Restoring Capabilities After an Incident

Restoring assets and operations affected by a cybersecurity incident.

| Category | ID | Mapped Subdomains | Skills |
|----------|-----|-------------------|--------|
| Incident Recovery Plan Execution | RC.RP | incident-response, ransomware-defense | 29 |
| Incident Recovery Communication | RC.CO | incident-response, compliance-governance | 29 |

**Primary subdomains:** incident-response (24), ransomware-defense (5)

## Function Coverage Distribution

```
Govern   (GV): ████████████░░░░░░░░  ~54 skills (compliance, IAM, devsecops)
Identify (ID): ██████████████████░░  ~115 skills (vuln-mgmt, threat-intel, cloud)
Protect  (PR): ████████████████████  ~160 skills (IAM, ZTA, devsecops, crypto)
Detect   (DE): ████████████████░░░░  ~102 skills (threat-hunting, SOC, malware)
Respond  (RS): ██████████████████░░  ~111 skills (IR, forensics, malware)
Recover  (RC): ████░░░░░░░░░░░░░░░░  ~29 skills (IR recovery, ransomware)
```

## How to Use This Mapping

### For Organizations

1. Determine your target CSF implementation tier (Partial, Risk Informed, Repeatable, Adaptive)
2. Identify your CSF function priorities
3. Use the category tables above to find relevant skill subdomains
4. Deploy skills from those subdomains to your team's training plan

### For AI Agents

Query skills by CSF function using subdomain filters:

```
# Find all Detect (DE) function skills
Filter: subdomain IN (threat-hunting, soc-operations, malware-analysis)

# Find all Protect (PR) function skills
Filter: subdomain IN (identity-access-management, zero-trust-architecture, devsecops, cryptography)
```

### For Security Teams

Use the alignment table in [`csf-alignment.md`](csf-alignment.md) for a complete subdomain-to-category cross-reference.

## References

- [NIST CSF 2.0 (February 2024)](https://www.nist.gov/cyberframework)
- [NIST SP 800-53 Rev. 5 Control Mapping](https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final)
- [CSF 2.0 Quick Start Guides](https://www.nist.gov/cyberframework/getting-started)
- [CSF 2.0 Reference Tool](https://csrc.nist.gov/Projects/Cybersecurity-Framework/Filters)
