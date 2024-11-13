import fs from "fs";
import { NodeConfig } from "./interfaces/node.interfaces";
import { Node } from "./classes/class.node";
import { Model } from "aethon-arion-pipeline";
import { C1Model } from "aethon-arion-c1/dist/classes/c1-model.class";

const nodeConfig: NodeConfig = JSON.parse(fs.readFileSync("./config/arion.config.node.json", "utf-8")) as NodeConfig;
const models: Model[] = [new C1Model([])];
const node = new Node(nodeConfig, models);
console.log("HERE")
node.start$().subscribe();
