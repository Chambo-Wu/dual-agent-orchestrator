# /build-feature

Build a complete feature with implementation, tests, and documentation.

## Usage
```
/build-feature [description of the feature]
```

## Process

This command orchestrates a full feature build using the Planner + Worker(s) architecture:

### Phase 1: Planning
Spawn @planner to:
1. Analyze the feature requirements
2. Decompose into atomic steps
3. Identify parallel opportunities
4. Create execution plan with acceptance criteria

### Phase 2: Implementation
Based on the plan, spawn workers:
- @coder: For implementation tasks
- @researcher: If external research is needed
- @writer: For documentation

Workers run in parallel when dependencies allow.

### Phase 3: Verification
Spawn @verifier to:
1. Run all tests
2. Verify acceptance criteria
3. Check code quality
4. Report findings

### Phase 4: Synthesis
Planner reviews verification:
- If pass: Report success with summary
- If fail: Decide retry strategy

## Example

```
/build-feature Add user profile page with avatar upload

## Plan Summary
- **Goal**: User profile page with avatar upload
- **Complexity**: Medium
- **Steps**: 4
- **Parallel**: Yes (steps 2-3)

## Execution Steps
1. Design profile schema → @coder
2. Implement profile API → @coder (parallel)
3. Implement avatar upload → @coder (parallel)
4. Create profile UI → @coder
5. Write tests → @coder
6. Document API → @writer

## Result
✅ Feature complete
- 6 files created/modified
- 23 tests passing
- Documentation updated
```

## Implementation

When you invoke `/build-feature`, I will:

1. Read your feature description
2. Spawn @planner to create execution plan
3. Execute plan with appropriate workers
4. Verify results with @verifier
5. Report final status

The process uses Claude Code's native task subagent system for parallel execution.
