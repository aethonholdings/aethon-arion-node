import { SimulationFactory } from 'aethon-arion-pipeline';

export interface NodeConfig {
    id?: string;
    host: string;
    port?: number;
    verbose?: boolean;
    saveStateSpace?: boolean;
    loopInterval: number;
    simulationFactories: SimulationFactory[];
}