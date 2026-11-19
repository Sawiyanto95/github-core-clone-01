# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Sawiyanto95/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Sawiyanto95/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process, with no
dependencies and no git binary: git smart HTTP (upload-pack protocol v2 and
receive-pack v0) for clone, fetch and push; the REST v3 API for repositories,
issues, pull requests and contents; the GraphQL v4 API; and a Model Context
Protocol endpoint. Everything is served from an in-memory store, so the forge
is fast and deterministic.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port, registers it with the harness through
`MAKEFUN_ENV_URL`, and exits once the harness reports done. The bearer token
it expects on every API call comes from `MAKEFUN_SHOP_TOKEN`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bc76ffwb&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
