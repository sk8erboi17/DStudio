# NIST CSF 2.0 Alignment Table

Complete mapping of each skill subdomain to NIST CSF 2.0 functions and categories.

## Subdomain-to-CSF Alignment

| Subdomain | Skills | GV | ID | PR | PR | DE | RS | RC |
|-----------|--------|-----|-----|-----|-----|-----|-----|-----|
| | | Govern | Identify | Protect | Protect | Detect | Respond | Recover |

### Detailed Alignment

| Subdomain (Skills) | Primary CSF Function | CSF Categories | Alignment Rationale |
|---------------------|---------------------|----------------|---------------------|
| api-security (28) | Protect (PR) | PR.DS, PR.PS | API hardening, authentication, input validation |
| cloud-security (48) | Identify (ID), Protect (PR) | ID.AM, PR.DS, PR.PS, PR.IR | Cloud asset management, data protection, infrastructure resilience |
| compliance-governance (5) | Govern (GV) | GV.OC, GV.RM, GV.RR, GV.PO, GV.OV | Risk strategy, policy, organizational oversight |
| container-security (26) | Protect (PR) | PR.PS, GV.SC | Platform security, supply chain risk management |
| cryptography (13) | Protect (PR) | PR.DS | Data confidentiality and integrity at rest and in transit |
| devsecops (16) | Protect (PR), Govern (GV) | PR.PS, GV.SC | Secure development lifecycle, supply chain security |
| digital-forensics (34) | Respond (RS) | RS.AN, RS.MA | Incident analysis, evidence collection and examination |
| endpoint-security (16) | Protect (PR), Detect (DE) | PR.PS, DE.CM, DE.AE | Endpoint hardening, continuous monitoring, threat detection |
| identity-access-management (33) | Protect (PR), Govern (GV) | PR.AA, GV.RR | Identity lifecycle, authentication, authorization, access governance |
| incident-response (24) | Respond (RS), Recover (RC) | RS.MA, RS.AN, RS.MI, RS.CO, RC.RP, RC.CO | Full incident lifecycle from detection through recovery |
| malware-analysis (34) | Detect (DE), Respond (RS) | DE.AE, RS.AN | Adverse event analysis, reverse engineering, threat characterization |
| mobile-security (12) | Protect (PR) | PR.PS, PR.DS | Mobile platform security, application data protection |
| network-security (33) | Protect (PR), Detect (DE) | PR.IR, DE.CM | Network infrastructure resilience, traffic monitoring |
| ot-ics-security (28) | Protect (PR), Detect (DE) | PR.PS, PR.IR, DE.CM | Industrial control system protection and monitoring |
| penetration-testing (23) | Identify (ID) | ID.RA | Risk assessment through offensive security testing |
| phishing-defense (16) | Protect (PR), Detect (DE) | PR.AT, DE.CM, DE.AE | Security awareness training, phishing detection |
| ransomware-defense (5) | Respond (RS), Recover (RC) | RS.MI, RC.RP | Ransomware mitigation and recovery planning |
| red-teaming (24) | Identify (ID) | ID.RA, ID.IM | Adversary simulation for risk assessment and program improvement |
| soc-operations (33) | Detect (DE), Respond (RS) | DE.CM, DE.AE, RS.MA | Continuous monitoring, alert triage, incident management |
| threat-hunting (35) | Detect (DE) | DE.CM, DE.AE | Proactive threat detection, hypothesis-driven analysis |
| threat-intelligence (43) | Identify (ID), Detect (DE) | ID.RA, DE.AE | Threat landscape understanding, intelligence-driven detection |
| vulnerability-management (24) | Identify (ID) | ID.RA, GV.RM | Vulnerability identification, risk assessment, remediation prioritization |
| web-application-security (41) | Protect (PR), Identify (ID) | PR.DS, PR.PS, ID.RA | Application security testing and hardening |
| zero-trust-architecture (13) | Protect (PR) | PR.AA, PR.IR | Zero trust access control and network segmentation |

## CSF Category Coverage Summary

### Govern (GV)

| Category | ID | Description | Subdomain Coverage |
|----------|-----|------------|-------------------|
| Organizational Context | GV.OC | Understanding the organizational mission and stakeholder expectations | compliance-governance |
| Risk Management Strategy | GV.RM | Risk management priorities, constraints, and appetite | compliance-governance, vulnerability-management |
| Roles, Responsibilities, and Authorities | GV.RR | Cybersecurity roles and authorities are established | compliance-governance, identity-access-management |
| Policy | GV.PO | Organizational cybersecurity policy is established | compliance-governance, zero-trust-architecture |
| Oversight | GV.OV | Results of cybersecurity activities are reviewed | compliance-governance, soc-operations |
| Cybersecurity Supply Chain Risk Management | GV.SC | Supply chain risks are managed | devsecops, container-security |

### Identify (ID)

| Category | ID | Description | Subdomain Coverage |
|----------|-----|------------|-------------------|
| Asset Management | ID.AM | Assets that enable the organization are identified and managed | cloud-security, container-security, network-security |
| Risk Assessment | ID.RA | The cybersecurity risk to the organization is understood | vulnerability-management, threat-intelligence, penetration-testing, red-teaming |
| Improvement | ID.IM | Improvements to organizational cybersecurity are identified | soc-operations, red-teaming, compliance-governance |

### Protect (PR)

| Category | ID | Description | Subdomain Coverage |
|----------|-----|------------|-------------------|
| Identity Management, Authentication, and Access Control | PR.AA | Access is limited to authorized users, services, and hardware | identity-access-management, zero-trust-architecture |
| Awareness and Training | PR.AT | Personnel are provided cybersecurity awareness and training | phishing-defense, compliance-governance |
| Data Security | PR.DS | Data are managed consistent with the organization's risk strategy | cryptography, cloud-security, api-security |
| Platform Security | PR.PS | Hardware, software, and services are managed consistent with risk strategy | endpoint-security, container-security, devsecops, ot-ics-security |
| Technology Infrastructure Resilience | PR.IR | Security architectures are managed to protect asset confidentiality, integrity, and availability | network-security, zero-trust-architecture, ot-ics-security |

### Detect (DE)

| Category | ID | Description | Subdomain Coverage |
|----------|-----|------------|-------------------|
| Continuous Monitoring | DE.CM | Assets are monitored to find anomalies and indicators of compromise | soc-operations, threat-hunting, network-security, endpoint-security |
| Adverse Event Analysis | DE.AE | Anomalies and potential adverse events are analyzed | threat-hunting, malware-analysis, soc-operations, threat-intelligence |

### Respond (RS)

| Category | ID | Description | Subdomain Coverage |
|----------|-----|------------|-------------------|
| Incident Management | RS.MA | Responses to detected incidents are managed | incident-response, soc-operations |
| Incident Analysis | RS.AN | Investigations are conducted to understand the incident | digital-forensics, malware-analysis, threat-intelligence |
| Incident Response Reporting and Communication | RS.CO | Response activities are coordinated with internal and external stakeholders | incident-response, compliance-governance |
| Incident Mitigation | RS.MI | Activities are performed to prevent expansion and mitigate effects | incident-response, endpoint-security, network-security |

### Recover (RC)

| Category | ID | Description | Subdomain Coverage |
|----------|-----|------------|-------------------|
| Incident Recovery Plan Execution | RC.RP | Restoration activities are performed to ensure operational availability | incident-response, ransomware-defense |
| Incident Recovery Communication | RC.CO | Restoration activities are coordinated with internal and external parties | incident-response, compliance-governance |

## Gap Analysis

| CSF Category | Current Coverage | Gap |
|-------------|-----------------|-----|
| GV.OC | Low (5 skills) | Need more organizational security context and mission alignment skills |
| GV.PO | Low | Need dedicated policy development and management skills |
| PR.AT | Moderate (16 skills) | Could expand security awareness training beyond phishing |
| RC.RP | Low (29 skills) | Need more disaster recovery and business continuity skills |
| RC.CO | Low | Need dedicated incident communication and stakeholder management skills |
