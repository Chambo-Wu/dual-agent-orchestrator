# Skill: find.integration_points

## Core Procedure

1. Discover likely integration boundaries for the user goal, such as routes, handlers, hooks, events, persistence adapters, producers, consumers, and UI consumption points.
2. Trace the connection path across the boundary by reading the files that send, receive, transform, store, or render the relevant data.
3. Capture the smallest useful path that explains how the integration works, including the entrypoint and at least one downstream or upstream consumer.
4. Identify the boundary that should be changed or preserved before implementation begins.

## Scenario Extensions

- For API or endpoint work, trace route registration, request handling, validation, persistence, and response consumers.
- For event-driven behavior, follow the event producer, event shape, dispatcher, listeners, and visible side effects.
- For UI-facing changes, include the backend or store path that supplies the data and the component or view that consumes it.
- When multiple boundaries look plausible, rank them by proximity to the user goal and evidence from call paths or tests.

## Appendix

- Intent: coding.
- Required tools: list_files, read_file, shell_command.
- Expected artifacts: integration_hits and call_path_excerpt.
- Success signal: at least one relevant integration boundary traced with supporting call path evidence.
- Remediation: repair missing or invalid boundary evidence, then re-trace the producer and consumer path before continuing.
