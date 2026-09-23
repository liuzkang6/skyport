# vendored from ZCode (Apache-2.0)

Source: https://github.com/zai-org/ZCode
Path: apps/zcode-cli/packages/core/src/workflow/
Copied: 2026-09-23

## Usage
This is the workflow engine extracted from ZCode for use as skyport's
orchestration engine base. The `scheduler/` and `lifecycle.ts` are the core
engine; `node-runner` will be replaced with skyport's governed node runner
(see src/services/playbook.ts for the current skyport-native implementation
that follows the same design grammar).

## License
Apache-2.0 — see LICENSE file and NOTICE in project root.
