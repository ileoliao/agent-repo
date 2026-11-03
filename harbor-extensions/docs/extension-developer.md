# I just want to build an extension

Build a small web extension for Harbor and see it running on the local sim, using three commands.

## Prerequisites

- `git clone` this repo and work from `harbor-extensions/` (the folder with the `Makefile`).
- Tools: `kubectl`, Python 3 with the backend deps (for `make validate`).
- To see your extension on the sim: the local sim must be up once. If you are not sure, run:
  `./deploy/sim/fuse-object-storage/run-fuse-sim.sh up`
  (`make try` tells you this command if the sim is missing.)
- UI-only work without a cluster: `scripts/dev.sh`.

## Shortest path

```bash
make new EXT=hello-world      # creates extensions/hello-world from the template
# edit extensions/hello-world/index.html, app.js, extension.yaml (owner, contact, description)
make try EXT=hello-world      # validate + publish to the local sim + check HTTP 200
make unpublish EXT=hello-world   # optional: remove it from the sim when you are done
```

`make try` ends with an "open this" block: the in-cluster URL plus a `port-forward` + `curl` pair for your Mac.

Names are lowercase-kebab (`hello-world`). Rules your code must follow (checked by `make validate`): no password inputs, no own `fetch`/XHR/WebSocket (use the `harbor` SDK), no browser storage/cookies, no inline scripts or event handlers, no external resources.

## Common errors

| Message | Next step |
|---|---|
| `cluster 'kind-harbor-sim' not reachable` | Start the sim: `./deploy/sim/fuse-object-storage/run-fuse-sim.sh up` |
| `local sim content store not set up` | Same command as above. |
| `validate exit code: 1` / `validation errors` | Read the messages above it, fix, run `make validate`. |
| `validate exit code: 2` | Not an error: it will need platform-team review in the PR. `make try` continues. |
| `FAIL: ... already exists` / `not lowercase-kebab` | Choose another `EXT` name. |
| HTTP 404 right after publish | The sim takes a few seconds to pick up new files. Run `make verify EXT=<name>` again. |
| `verify FAILED` | Run the `kubectl ... logs` command printed in the hint, then retry `make try`. |

## More

- Operator details of the local sim: [deploy/sim/fuse-object-storage/README.md](../deploy/sim/fuse-object-storage/README.md)
- Platform and architecture: [../README.md](../README.md)
- Copilot rules for extension code: `.github/copilot-instructions.md`
