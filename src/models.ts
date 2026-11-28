import { Model } from "aethon-arion-pipeline";
import { C1 } from "aethon-arion-c1";

/** The models this node can simulate; shared by the main thread and the simulation worker. */
export const models: Model[] = [C1];
