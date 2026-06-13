# /orchestrator-demo

Demonstrate the Dual Agent Orchestrator architecture in action.

## Usage
```
/orchestrator-demo
```

## What This Does

This command demonstrates the Planner + Worker(s) architecture by executing a sample task with full orchestration:

1. **Planning Phase**: @planner analyzes the task and creates an execution plan
2. **Execution Phase**: Workers execute in parallel where possible
3. **Verification Phase**: @verifier validates the results
4. **Synthesis**: Final report with evidence

## Demo Task

Build a simple "Hello World" API endpoint with:
- Express.js route
- Input validation
- Error handling
- Tests
- Documentation

## Expected Flow

```
User: /orchestrator-demo

## Phase 1: Planning (@planner)
Analyzing task...
Creating execution plan...

## Execution Plan
1. Setup Express project → @coder
2. Create /hello endpoint → @coder
3. Add input validation → @coder
4. Write tests → @coder
5. Write documentation → @writer

## Phase 2: Execution (Parallel)
Spawning workers...
- @coder: Setting up project...
- @coder: Creating endpoint...
- @coder: Adding validation...
- @coder: Writing tests...
- @writer: Writing docs...

## Phase 3: Verification (@verifier)
Running tests...
Checking code quality...
Verifying documentation...

## Phase 4: Results
✅ Demo complete!
- 5 files created
- 12 tests passing
- Documentation complete
- All acceptance criteria met

## Architecture Notes
This demo showed:
- Task decomposition by @planner
- Parallel execution by workers
- Quality verification by @verifier
- Synthesis of results
```

## Why This Matters

This demonstrates the core architecture of Dual Agent Orchestrator:

1. **Separation of Concerns**: Each agent has a specific role
2. **Parallel Execution**: Independent tasks run simultaneously
3. **Quality Gates**: Verification before completion
4. **Observable Progress**: Clear status at each phase

## Implementation

When you invoke `/orchestrator-demo`, I will:

1. Create a sample task
2. Show the planning process
3. Execute with parallel workers
4. Demonstrate verification
5. Report final status

This proves the architecture works in Claude Code without external services.
