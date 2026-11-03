# Test report

This report records the release checks run from the repository root on 2026-11-04.

## Environment

- Node.js `v22.23.3`
- npm `10.9.9`
- Platform: Linux

## Checks

| Command | Result | Observed result |
|---|---|---|
| `rm -rf node_modules && npm ci` | PASS | Added 7 packages; audited 8 packages; 0 vulnerabilities reported. |
| `npm run typecheck` | PASS | TypeScript completed with exit code 0 and no diagnostics. |
| `npm test` | PASS | Build completed and all 4 Node test cases passed. |
| `npm run build` | PASS | TypeScript completed with exit code 0. |
| `node dist/cli.js validate --input test/fixtures/pets.yaml` | PASS | Printed `valid OpenAPI 3.0.3 document`. |
| `node dist/cli.js generate --input test/fixtures/pets.yaml --output generated/pets` | PASS | Printed `generated 2 tool(s) in 13 files: generated/pets`. |

The generated sample directory was removed after verification. `generated/`,
`dist/`, and `node_modules/` remain ignored build or dependency output.
