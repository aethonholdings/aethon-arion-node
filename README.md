# aethon-arion-node

## Description

This package defines the simulation distributed calculation node for an Arion simulation, as specified on the project's [homepage](https://arion.aethon.sg/our-tools/aethon-arion-node/).  The classes implement the modelling and mathematical objects described on the Arion [framework pages](https://arion.aethon.sg/our-framework/).

## Configuration

The node reads `config/arion.config.node.json` from the package root, or the path given as the first CLI argument or in `ARION_NODE_CONFIG`:

| Key | Meaning |
|---|---|
| `host`, `port`, `basePath`, `protocol` | Server address |
| `loopInterval` | Polling interval in ms (at least 100) |
| `saveStateSpace` | Cap: `false` disables state space recording even when a simulation configuration requests it (default `true`) |
| `requestTimeoutMs`, `postTimeoutMs` | HTTP timeouts in ms (defaults 30000 and 120000) |
| `verbose`, `id` | Logging, node id override |

Each job is simulated with random streams derived from `(simConfig id, runIndex)`, so runs are distinct across nodes and reproducible. Failed requests are retried on the next tick. Result posts are retried only on network errors, timeouts, 5xx and 429, and are idempotent on the server. An invalid configuration exits with code 1.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests as appropriate.

## License

[MIT](https://choosealicense.com/licenses/mit/)