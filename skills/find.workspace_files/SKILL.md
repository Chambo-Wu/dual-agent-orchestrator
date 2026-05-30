# Skill: find.workspace_files

## Core Procedure

1. Scan the workspace structure to identify likely directories, manifests, schemas, configs, environment examples, and neighboring assets relevant to the user goal.
2. Narrow the candidate list using filenames, extensions, package layout, and nearby tests or documentation.
3. Read the strongest candidate files and capture concise excerpts or summaries that explain why each target matters.
4. Use the discovered files to anchor the next analysis or edit, and call out any expected target that is missing.

## Scenario Extensions

- For config or schema work, inspect the schema, example config, parser, and tests that exercise the same keys.
- For feature work, include neighboring files that define types, routes, UI consumers, or fixtures for the feature area.
- For unfamiliar repositories, start with root manifests and documentation before searching deeper paths.
- When many files match, group hits by directory or responsibility so the next step can choose a focused entrypoint.

## Appendix

- Intent: coding.
- Required tools: list_files, read_file, shell_command.
- Expected artifacts: file_hits and config_excerpt.
- Success signal: at least one relevant workspace target with supporting config, schema, or file evidence.
- Remediation: collect concrete file hits and excerpts, then recheck that they support the user goal before continuing.
