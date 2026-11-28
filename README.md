# aethon-arion-node

## Description

This package defines the simulation distributed calculation node for an Arion simulation, as specified on the project's [homepage](https://arion.aethon.sg/our-tools/aethon-arion-node/).  The classes implement the modelling and mathematical objects described on the Arion [framework pages](https://arion.aethon.sg/our-framework/).

## Configuration

The node reads `config/arion.config.node.json` from the package root, or the path given as the first CLI argument or in `ARION_NODE_CONFIG`:

| Key | Meaning |
|---|---|
| `host`, `port`, `protocol` | Server address; replaced by the server the node was authorised by (see below) |
| `basePath` | API path prefix (`arion`) |
| `loopInterval` | Polling interval in ms (at least 100) |
| `saveStateSpace` | Cap: `false` disables state space recording even when a simulation configuration requests it (default `true`) |
| `requestTimeoutMs`, `postTimeoutMs` | HTTP timeouts in ms (defaults 30000 and 120000) |
| `verbose`, `id` | Logging, machine id override (the node's key is bound to the machine id) |
| `simulationThread` | `worker` (default when started with `npm start`): simulations run in a worker thread, so the node stays responsive during a run and a run can be cancelled; `main`: in the main thread |

Each job is simulated with random streams derived from `(simConfig id, runIndex)`, so runs are distinct across nodes and reproducible. Failed requests are retried on the next tick. Result posts are retried only on network errors, timeouts, 5xx and 429, and are idempotent on the server. An invalid configuration exits with code 1.

## Authorisation

The server only accepts nodes it has authorised. Authorise a node once, with the credentials of an operator account created on the server (`npm run user:create` there):

```
npm run build
npm run login            # or: node dist/src/main.js login [config] [--allow-http]
```

`login` asks for the server address (a URL, host name or IP address, with an optional port), then the username and the password (not echoed). The server checks them and issues a key bound to this machine's id. The node saves the server address and the key in `~/.arion/node-credentials.json` (or `ARION_NODE_CREDENTIALS`), readable by the current user only, and sends the key as `Authorization: Bearer <key>` with every request.

| Situation | Behaviour |
|---|---|
| Address without a scheme | https, except `localhost` and `127.0.0.1` (http) |
| Plain http to another host | Refused, because the password and the key would cross the network readable; `--allow-http` overrides |
| `npm run login` | Authorises the node and saves the key, then exits; it never starts the node |
| `npm start` with no key | Exits with code 1; run `login` first, or set `ARION_SERVER_URL` and `ARION_NODE_KEY` |
| The server rejects the key (revoked, or replaced by a newer `login` of this machine) | The node stops with code 1 and asks for `login` |

Keys do not expire. A key stays valid until it is revoked on the server (`npm run node:revoke <id>`) or replaced by a new `login` from the same machine.

## Results the server cannot take

A result that cannot be posted (server unreachable, 5xx, timeout, or the key refused) is written to `~/.arion/results` (or `ARION_NODE_RESULTS`; `resultBufferDir` in the configuration, `false` to switch off). Before it takes new work, a node process posts the buffered results, oldest first; while they cannot be posted it takes no new work and backs off. The files survive a restart, and the processes of one machine share the directory (each claims a file before posting it). A result the server refuses outright (for example 400) is moved to `rejected/` in that directory.

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

Please make sure to update tests as appropriate.

## License

[MIT](https://choosealicense.com/licenses/mit/)