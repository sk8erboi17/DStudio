# ATT&CK Coverage Summary

Coverage analysis of the 753 cybersecurity skills mapped to MITRE ATT&CK Enterprise v15 tactics.

## Tactic Coverage Matrix

| ATT&CK Tactic | ID | Relevant Subdomains | Skills Count |
|---------------|-----|---------------------|--------------|
| Reconnaissance | TA0043 | threat-intelligence, penetration-testing, red-teaming | ~48 |
| Resource Development | TA0042 | threat-intelligence, red-teaming | ~30 |
| Initial Access | TA0001 | web-application-security, phishing-defense, api-security | ~45 |
| Execution | TA0002 | malware-analysis, endpoint-security, soc-operations | ~32 |
| Persistence | TA0003 | threat-hunting, digital-forensics, endpoint-security | ~28 |
| Privilege Escalation | TA0004 | penetration-testing, red-teaming, identity-access-management | ~40 |
| Defense Evasion | TA0005 | malware-analysis, endpoint-security, threat-hunting | ~25 |
| Credential Access | TA0006 | identity-access-management, penetration-testing | ~30 |
| Discovery | TA0007 | penetration-testing, threat-hunting, network-security | ~35 |
| Lateral Movement | TA0008 | red-teaming, network-security, soc-operations | ~28 |
| Collection | TA0009 | digital-forensics, threat-hunting | ~22 |
| Command and Control | TA0011 | threat-intelligence, network-security, soc-operations | ~30 |
| Exfiltration | TA0010 | threat-hunting, digital-forensics, network-security | ~20 |
| Impact | TA0040 | ransomware-defense, incident-response, ot-ics-security | ~35 |

## Subdomain-to-Tactic Heat Map

Shows which subdomains contribute skills to each ATT&CK tactic. Intensity indicates relevance (H = High, M = Medium, L = Low).

| Subdomain (skills) | Recon | Res Dev | Init Access | Exec | Persist | Priv Esc | Def Evasion | Cred Access | Disc | Lat Mov | Collect | C2 | Exfil | Impact |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| web-application-security (41) | L | - | **H** | M | L | M | L | M | L | - | - | - | - | M |
| threat-intelligence (43) | **H** | **H** | M | L | L | - | L | - | M | - | - | **H** | L | L |
| threat-hunting (35) | L | - | M | M | **H** | M | **H** | M | **H** | M | **H** | M | **H** | M |
| digital-forensics (34) | - | - | L | M | **H** | L | M | L | L | M | **H** | L | M | M |
| malware-analysis (34) | - | L | M | **H** | **H** | M | **H** | L | L | L | M | **H** | L | M |
| identity-access-management (33) | - | - | M | L | M | **H** | L | **H** | L | M | - | - | - | - |
| network-security (33) | M | - | M | L | L | L | L | L | M | **H** | L | **H** | **H** | L |
| soc-operations (33) | L | - | M | **H** | M | M | M | M | M | M | M | M | M | M |
| cloud-security (48) | M | M | **H** | M | M | **H** | M | **H** | **H** | M | M | L | M | M |
| api-security (28) | L | - | **H** | M | L | M | L | **H** | L | - | M | - | M | L |
| ot-ics-security (28) | M | L | M | M | M | L | L | M | **H** | M | **H** | M | L | **H** |
| container-security (26) | L | L | M | **H** | M | **H** | **H** | M | M | L | L | L | M | M |
| incident-response (24) | - | - | M | M | M | M | M | M | L | M | M | M | M | **H** |
| vulnerability-management (24) | M | - | **H** | M | L | M | L | L | **H** | L | - | - | - | M |
| penetration-testing (23) | **H** | M | **H** | **H** | M | **H** | M | **H** | **H** | M | M | M | M | L |
| red-teaming (24) | **H** | **H** | **H** | **H** | **H** | **H** | **H** | **H** | **H** | **H** | **H** | **H** | **H** | **H** |
| devsecops (16) | L | L | M | M | L | M | L | M | L | - | - | - | - | L |
| endpoint-security (16) | - | - | M | **H** | **H** | **H** | **H** | M | M | M | M | M | L | M |
| phishing-defense (16) | M | M | **H** | M | - | - | M | **H** | - | - | M | L | L | L |
| cryptography (13) | - | - | L | - | - | - | M | **H** | - | - | M | M | **H** | L |
| zero-trust-architecture (13) | - | - | M | L | L | **H** | L | **H** | L | **H** | L | L | M | - |
| mobile-security (12) | M | L | **H** | M | M | M | M | M | M | L | M | M | M | L |
| compliance-governance (5) | L | L | L | - | - | L | - | L | L | - | - | - | - | L |
| ransomware-defense (5) | - | - | M | M | M | L | M | - | - | - | M | M | L | **H** |

## Key Technique Coverage

High-confidence technique-to-skill mappings based on skill content analysis.

### Initial Access (TA0001) -- 45 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Phishing | T1566 | analyzing-phishing-email-headers, analyzing-certificate-transparency-for-phishing, 14 phishing-defense skills |
| Exploit Public-Facing Application | T1190 | 41 web-application-security skills, 28 api-security skills |
| External Remote Services | T1133 | network-security VPN/remote access skills |
| Valid Accounts | T1078 | identity-access-management credential skills |
| Supply Chain Compromise | T1195 | analyzing-supply-chain-malware-artifacts, devsecops dependency scanning |

### Execution (TA0002) -- 32 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Command and Scripting Interpreter | T1059 | malware-analysis script analysis skills |
| Exploitation for Client Execution | T1203 | web-application-security exploit skills |
| User Execution | T1204 | phishing-defense awareness skills |
| Container Administration Command | T1609 | container-security skills |

### Persistence (TA0003) -- 28 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Boot or Logon Autostart Execution | T1547 | analyzing-malware-persistence-with-autoruns, analyzing-windows-registry-for-artifacts |
| Scheduled Task/Job | T1053 | endpoint-security scheduled task skills |
| Create Account | T1136 | identity-access-management monitoring skills |
| Implant Internal Image | T1525 | container-security image scanning skills |

### Privilege Escalation (TA0004) -- 40 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Exploitation for Privilege Escalation | T1068 | penetration-testing privilege escalation skills |
| Access Token Manipulation | T1134 | identity-access-management token skills |
| Container Escape | T1611 | container-security escape detection skills |
| Domain Policy Modification | T1484 | identity-access-management AD skills |

### Defense Evasion (TA0005) -- 25 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Obfuscated Files or Information | T1027 | analyzing-packed-malware-with-upx-unpacker, malware deobfuscation skills |
| Masquerading | T1036 | threat-hunting detection skills |
| Rootkit | T1014 | analyzing-bootkit-and-rootkit-samples |
| Indicator Removal | T1070 | digital-forensics anti-forensics skills |

### Credential Access (TA0006) -- 30 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| OS Credential Dumping | T1003 | analyzing-memory-dumps-with-volatility, penetration-testing credential skills |
| Brute Force | T1110 | identity-access-management authentication skills |
| Steal Web Session Cookie | T1539 | web-application-security session skills |
| Unsecured Credentials | T1552 | cloud-security secrets management skills |

### Discovery (TA0007) -- 35 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Network Service Discovery | T1046 | network-security scanning skills, penetration-testing recon |
| System Information Discovery | T1082 | threat-hunting system enumeration skills |
| Cloud Infrastructure Discovery | T1580 | cloud-security asset discovery skills |
| Account Discovery | T1087 | identity-access-management enumeration skills |

### Lateral Movement (TA0008) -- 28 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Remote Services | T1021 | network-security remote access skills |
| Lateral Tool Transfer | T1570 | threat-hunting lateral movement detection skills |
| Use Alternate Authentication Material | T1550 | identity-access-management pass-the-hash skills |
| Exploitation of Remote Services | T1210 | penetration-testing exploitation skills |

### Collection (TA0009) -- 22 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Data from Local System | T1005 | digital-forensics disk/file analysis skills |
| Data from Network Shared Drive | T1039 | threat-hunting data access monitoring skills |
| Email Collection | T1114 | analyzing-outlook-pst-for-email-forensics |
| Screen Capture | T1113 | malware-analysis behavior analysis skills |

### Command and Control (TA0011) -- 30 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Application Layer Protocol | T1071 | analyzing-command-and-control-communication, network-security C2 detection |
| Encrypted Channel | T1573 | analyzing-network-covert-channels-in-malware |
| Ingress Tool Transfer | T1105 | analyzing-cobalt-strike-beacon-configuration |
| Proxy | T1090 | network-security proxy analysis skills |

### Exfiltration (TA0010) -- 20 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Exfiltration Over C2 Channel | T1041 | analyzing-dns-logs-for-exfiltration |
| Exfiltration Over Alternative Protocol | T1048 | network-security protocol analysis skills |
| Exfiltration Over Web Service | T1567 | cloud-security data loss prevention skills |

### Impact (TA0040) -- 35 skills

| Technique | ID | Primary Skills |
|-----------|----|---------------|
| Data Encrypted for Impact | T1486 | analyzing-ransomware-encryption-mechanisms, 5 ransomware-defense skills |
| Service Stop | T1489 | incident-response service restoration skills |
| Inhibit System Recovery | T1490 | ransomware-defense recovery skills |
| Manipulation of Control | T0831 | ot-ics-security control system skills |

## Coverage Gaps

Areas where additional skills would improve ATT&CK coverage:

| Gap Area | ATT&CK Techniques | Recommendation |
|----------|-------------------|----------------|
| Firmware attacks | T1542 (Pre-OS Boot) | Add UEFI/firmware analysis skills |
| Audio/video capture | T1123, T1125 | Add surveillance detection skills |
| Cloud-specific lateral movement | T1550.001 (Web Session Cookie in cloud) | Expand cloud-security lateral movement |
| Hardware additions | T1200 | Add physical security assessment skills |
| Traffic signaling | T1205 | Add network covert channel detection skills |
