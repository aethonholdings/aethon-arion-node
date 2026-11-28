import { ResultDTO, SimConfigDTO } from "aethon-arion-pipeline";

/** Main thread to worker: simulate one run. */
export type RunMessage = { type: "run"; id: number; job: SimConfigDTO; nodeId: string; saveStateSpace: boolean; verbose: boolean };

/** Worker to main thread. Progress is throttled (at most every 250 ms, and at the end). */
export type WorkerMessage =
    | { type: "ready" }
    | { type: "progress"; id: number; clockTick: number; totalClockTicks: number }
    | { type: "result"; id: number; result: ResultDTO | null }
    | { type: "error"; id: number; message: string }
    | { type: "log"; level: string; sourceObject: string; message: string; data?: any };
