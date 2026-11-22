# mend

[![make.fun](https://img.shields.io/badge/make.fun-bounty-7c3aed)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?ref=v0mk9kpb)
[![Node.js](https://img.shields.io/badge/node-22-339933)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

One patch tool for every AI edit format. `mend` reads a patch in any of four formats — unified diff (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — finds the lines each edit names at the first of three matching tiers, and changes every file or none.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

See [SPEC.md](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) for the full contract. Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?ref=v0mk9kpb).
