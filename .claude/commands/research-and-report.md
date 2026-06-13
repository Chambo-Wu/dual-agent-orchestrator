# /research-and-report

Conduct thorough research and produce a comprehensive report.

## Usage
```
/research-and-report [research question or topic]
```

## Process

This command orchestrates a research workflow:

### Phase 1: Research Planning
Spawn @planner to:
1. Clarify research goals
2. Identify information needs
3. Plan research strategy
4. Define success criteria

### Phase 2: Information Gathering
Spawn @researcher to:
1. Search for relevant sources
2. Fetch and analyze content
3. Collect evidence
4. Note source credibility

### Phase 3: Analysis
Spawn @researcher (continued) to:
1. Synthesize findings
2. Identify patterns
3. Draw conclusions
4. Note confidence levels

### Phase 4: Report Writing
Spawn @writer to:
1. Structure findings
2. Write clear prose
3. Add citations
4. Create executive summary

### Phase 5: Verification
Spawn @verifier to:
1. Check source accuracy
2. Verify claims are supported
3. Identify gaps
4. Suggest improvements

## Example

```
/research-and-report Compare state management solutions for React

## Research Plan
- **Question**: Which state management for React?
- **Scope**: Redux, Zustand, Jotai, Recoil
- **Criteria**: Performance, DX, bundle size, ecosystem

## Sources Analyzed
- Official documentation (4)
- Technical blog posts (12)
- GitHub repositories (4)
- npm download stats

## Key Findings
1. Redux: Most mature, largest ecosystem, steeper learning curve
2. Zustand: Simplest API, good performance, growing fast
3. Jotai: Atomic approach, excellent performance, newer
4. Recoil: Facebook-backed, experimental status

## Report
📄 `research/react-state-management-comparison.md`

## Confidence
- **Overall**: High
- **Evidence**: Strong (primary sources + benchmarks)
- **Gaps**: Long-term maintenance data limited for newer libs
```

## Implementation

When you invoke `/research-and-report`, I will:

1. Parse your research question
2. Spawn @planner for research strategy
3. Spawn @researcher for information gathering
4. Spawn @writer for report creation
5. Spawn @verifier for accuracy check
6. Deliver final report with sources
