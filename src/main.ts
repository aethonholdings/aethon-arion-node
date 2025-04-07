import fs from "fs";
import { NodeConfig } from "./interfaces/node.interfaces";
import { Node } from "./classes/class.node";
import { Model } from "aethon-arion-pipeline";
import { C1 } from "aethon-arion-c1";

const nodeConfig: NodeConfig = JSON.parse(fs.readFileSync("./config/arion.config.node.json", "utf-8")) as NodeConfig;
const models: Model[] = [C1];
const node = new Node(nodeConfig, models);
node.start$().subscribe();
