# Skill: find.code_symbol

## Core Procedure

1. List or search repository files to locate likely entrypoints, modules, routes, functions, classes, and config definitions related to the user goal.
2. Search for the most relevant symbols and read the matching files instead of relying on names alone.
3. Capture concrete symbol hits with enough surrounding context to understand ownership, call sites, and edit surface.
4. Use the symbol evidence to choose the smallest responsible code area before changing behavior.

## Scenario Extensions

- For bug fixes, search both the failing behavior name and adjacent tests, fixtures, or error messages.
- For implementation work, include entrypoints and type or interface definitions that constrain the change.
- For route or handler work, trace from registration to the handler and any shared helper it depends on.
- When a symbol has many matches, prefer definitions, exported APIs, and direct call sites over incidental text matches.

## Appendix

- Intent: coding.
- Required tools: list_files, read_file, shell_command.
- Expected artifacts: symbol_hits and file_excerpt.
- Success signal: at least one relevant entrypoint with supporting repository excerpt.
- Remediation: capture concrete symbol hits and file excerpts, then verify they point to the correct edit surface before continuing.
