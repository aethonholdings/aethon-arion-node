import { NodeConfig } from "../../src/interfaces/node.interfaces";

export const nodeConfig: NodeConfig = {
    id: "test",
    host: "127.0.0.1",
    port: 3000,
    basePath: "arion",
    verbose: false,
    saveStateSpace: false,
    loopInterval: 2000
};
