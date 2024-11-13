import { APIProtocol } from 'aethon-api-types';

export interface NodeConfig {
    id?: string;
    host: string;
    protocol?: APIProtocol;
    port?: number;
    basePath?: string;
    verbose?: boolean;
    saveStateSpace?: boolean;
    loopInterval: number;
}