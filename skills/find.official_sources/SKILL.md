# Skill: find.official_sources

## Core Procedure

1. Search for candidate official sources that match the user goal, prioritizing product documentation, source repositories, release notes, announcements, standards, or other primary publishers.
2. Fetch the strongest candidates and verify why each source is primary: publisher identity, project ownership, canonical domain, repository ownership, or explicit release authority.
3. Summarize the relevant facts from the official sources and keep the source list tied to the claim or decision it supports.
4. If fewer than two strong primary sources are found, broaden or refine the query once before relying on weaker evidence.

## Scenario Extensions

- For "latest" or version-sensitive questions, prefer release notes, changelogs, official docs, and repository tags over secondary summaries.
- For open source projects, compare official documentation with the canonical repository or package metadata when both are available.
- For standards or policies, prefer the standards body, regulator, vendor, or project owner responsible for the text.
- When a source is official but incomplete, state the gap and use secondary sources only as context, not as primary evidence.

## Appendix

- Intent: research.
- Required tools: web_search, url_fetch, read_file.
- Expected artifacts: search_results and primary_source_summary.
- Success signal: at least two non-empty primary sources with a short explanation of why they are official.
- Remediation: replace weak or invalid sources, fetch stronger primary evidence, and update the summary before continuing.
