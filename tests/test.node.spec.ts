import { firstValueFrom, lastValueFrom } from "rxjs";
import { Node } from "../src/classes/class.node";
import { NodeConfig } from "../src/interfaces/node.interfaces";
import { RandomStreamFactory, ResultDTO } from "aethon-arion-pipeline";
import { simpleC1SimulationConfig } from "./init/test.init.simconfig";
import { C1Simulation } from "aethon-arion-c1";
import { LogLine } from "../../core/dist/interfaces/interfaces";

export function runSimulationTest(description: string, nodeConfig: NodeConfig) {
    let node: Node;
    const runIterations = 1;
    const verbose: boolean = true;

    describe(description, () => {
        const originalTimeout: number = jasmine.DEFAULT_TIMEOUT_INTERVAL;

        beforeAll(() => {
            verbose ? spyOn(console, "log").and.callThrough() : spyOn(console, "log").and.stub();
        });

        it("creates a new node", () => {
            node = new Node(nodeConfig);
            expect(node).toBeTruthy();
            expect(node).toBeInstanceOf(Node);
            if (nodeConfig.verbose) {
                node.getLog$().subscribe((logLine: LogLine) => {
                    console.log(logLine);
                });
            }            
        });

        it("initialises random stream factory, connects to the server and fetches seeds", async () => {
            const promise = await firstValueFrom(node.initialiseStreamFactory$());
            expect(promise).toBeTruthy();
            expect(promise).toBeInstanceOf(RandomStreamFactory);
        });

        it("does not re-initialise initialised node", async () => {
            const promise1 = await firstValueFrom(node.initialiseStreamFactory$());
            const promise2 = await firstValueFrom(node.initialiseStreamFactory$());
            expect(promise1 === promise2).toBeTrue();
        });

        it("runs the simulation loop", async () => {
            const randomStreamFactory: RandomStreamFactory | undefined = node.getRandomStreamFactory();
            expect(randomStreamFactory).not.toBeUndefined();
            if (randomStreamFactory !== undefined) {
                const simulation = new C1Simulation(simpleC1SimulationConfig, node.getLogger(), randomStreamFactory);
                const promise: ResultDTO = await lastValueFrom(node.simulate$(simulation, runIterations, 1));
                expect(promise).not.toBeUndefined();
                expect(promise.runCount).toBe(runIterations);
            }
        });

        jasmine.DEFAULT_TIMEOUT_INTERVAL = 100000;
        it("starts the node", async () => {
            const promise = await firstValueFrom(node.start$());
            expect(promise).toBeGreaterThanOrEqual(0);
        });
        jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
    });
}
