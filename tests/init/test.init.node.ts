import { C1SimulationFactory } from "aethon-arion-c1";
import { NodeConfig } from "../../src/interfaces/node.interfaces";

export const nodeConfig: NodeConfig ={
    id: "test",
    host: "http://localhost:3000/arion",
    verbose: true,
    saveStateSpace: true,
    loopInterval: 2000,
    simulationFactories: [new C1SimulationFactory()]
  }
  