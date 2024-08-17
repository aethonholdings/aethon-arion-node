import fs from "fs";
import { NodeConfig } from "./interfaces/node.interfaces";
import { C1SimulationFactory } from "aethon-arion-c1";
import { Node } from "./classes/class.node";

const nodeConfig: NodeConfig = JSON.parse(fs.readFileSync("./config/arion.config.node.json", "utf-8")) as NodeConfig;
nodeConfig.simulationFactories = [];
nodeConfig.simulationFactories.push(new C1SimulationFactory());
const node = new Node(nodeConfig);
node.start$().subscribe();

