# vendored from ZCode (Apache-2.0)

Source: https://github.com/zai-org/ZCode
Path: apps/zcode-cli/packages/core/src/workflow/
Copied: 2026-09-23

## Usage
The scheduler core (`scheduler/`, `lifecycle.ts`) now **actually runs** in
skyport: `src/services/vendor-engine.ts` compiles playbooks into
`WorkflowRunSnapshot` and drives them through `WorkflowGraphScheduler` with a
governed runner (every step goes through the skyport action system).
`src/services/playbook.ts` remains as the native reference implementation.

Fork maintenance notes (beyond the upstream copy):
- `contracts.ts` is a skyport-maintained shim for the upstream
  `@zcode/contracts` package (types + derive functions + zod schemas),
  reconstructed from engine usage; wired via tsconfig `paths`,
  `vitest.config.ts` alias, and esbuild path resolution.
- `scheduler/types.ts` / `scheduler/events.ts`: optional properties widened
  with `| undefined` to satisfy the host tsconfig's
  `exactOptionalPropertyTypes` (no behavioral change).

## License
Apache-2.0 — see LICENSE file and NOTICE in project root.
