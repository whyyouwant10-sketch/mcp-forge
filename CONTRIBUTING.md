# Contributing to MCP Forge

MCP Forge is in early development. Contributions that improve correctness,
determinism, documentation, and generated-project safety are welcome.

## Development setup

Requirements:

- Node.js 20 or newer
- npm

Install the locked dependencies and run the checks:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The sample OpenAPI document can be validated and generated locally:

```sh
node dist/cli.js validate --input test/fixtures/pets.yaml
node dist/cli.js generate --input test/fixtures/pets.yaml --output generated/pets
```

Generated output under `generated/` and compiler output under `dist/` are
ignored by Git. Do not commit dependency directories, generated output, or
credentials.

## Making changes

- Keep changes focused and preserve deterministic output.
- Add or update tests for behavior changes.
- Keep user-facing limitations documented in `README.md` and the relevant
  design contract in `docs/SPEC.md`.
- Run the complete check set before opening a pull request.
- Use clear, imperative commit messages and describe user-visible behavior in
  the pull request.

## Pull requests

A pull request should explain the problem, summarize the implementation, and
include the exact checks that were run. Changes that affect generated files,
the CLI contract, or security behavior should include representative fixture
coverage and documentation updates.
