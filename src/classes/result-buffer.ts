import fs from "fs";
import os from "os";
import path from "path";
import { ResultDTO } from "aethon-arion-pipeline";

/** The buffer directory: ARION_NODE_RESULTS, else ~/.arion/results. */
export function defaultResultBufferDir(env: NodeJS.ProcessEnv = process.env): string {
    return env.ARION_NODE_RESULTS ? path.resolve(env.ARION_NODE_RESULTS) : path.join(os.homedir(), ".arion", "results");
}

/** A buffered result claimed by this process for posting. */
export interface ClaimedResult {
    file: string;
    result: ResultDTO;
}

/**
 * Results that could not be posted, kept on disk until the server takes them (node plan step 2.5).
 *
 * @remarks
 * - One JSON file per result, written to a temporary name and renamed, so a crash never leaves a half-written file.
 * - Processes on one machine share the directory: a process claims a file by renaming it to `<name>.claimed-<pid>`
 *   (rename is atomic, so two processes never post the same file); a claim left by a process that died is taken
 *   over after `staleClaimMs`. The server records a run's result once (a repeat post is answered 409), so a
 *   result posted twice after a crash is harmless.
 * - Results the server refuses outright (4xx other than 401, 403, 408, 409, 429) are moved to `rejected/`.
 */
export class ResultBuffer {
    readonly dir: string;
    private _staleClaimMs: number;

    constructor(dir: string, staleClaimMs: number = 10 * 60 * 1000) {
        this.dir = dir;
        this._staleClaimMs = staleClaimMs;
    }

    /** Writes a result to the buffer and returns its file name. */
    save(result: ResultDTO): string {
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const name = `${Date.now()}-${result.runId ?? "x"}-${process.pid}-${Math.floor(Math.random() * 1e9)}.json`;
        const tmp = path.join(this.dir, `.${name}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(result), { mode: 0o600 });
        fs.renameSync(tmp, path.join(this.dir, name));
        return name;
    }

    /** Buffered results not yet claimed (or claimed by a process that died), oldest first. */
    pending(): string[] {
        let names: string[];
        try {
            names = fs.readdirSync(this.dir);
        } catch {
            return [];
        }
        const now = Date.now();
        return names
            .filter((name) => {
                if (name.endsWith(".json")) return true;
                const claim = /\.json\.claimed-\d+$/.test(name);
                if (!claim) return false;
                try {
                    return now - fs.statSync(path.join(this.dir, name)).ctimeMs > this._staleClaimMs;
                } catch {
                    return false;
                }
            })
            .sort();
    }

    /** Number of results waiting in the buffer (including claimed ones). */
    count(): number {
        try {
            return fs.readdirSync(this.dir).filter((name) => /\.json(\.claimed-\d+)?$/.test(name)).length;
        } catch {
            return 0;
        }
    }

    /** Claims a buffered result for posting; null when another process took it first or it cannot be read. */
    claim(name: string): ClaimedResult | null {
        const base = name.replace(/\.claimed-\d+$/, "");
        const file = path.join(this.dir, `${base}.claimed-${process.pid}`);
        try {
            fs.renameSync(path.join(this.dir, name), file);
        } catch {
            return null;
        }
        try {
            return { file, result: JSON.parse(fs.readFileSync(file, "utf8")) };
        } catch {
            this._move(file, "rejected", base); // unreadable: kept aside, not retried
            return null;
        }
    }

    /** The server took the result. */
    done(claimed: ClaimedResult): void {
        try {
            fs.unlinkSync(claimed.file);
        } catch {
            // already gone
        }
    }

    /** Posting failed for now: back in the buffer for the next attempt. */
    release(claimed: ClaimedResult): void {
        try {
            fs.renameSync(claimed.file, claimed.file.replace(/\.claimed-\d+$/, ""));
        } catch {
            // the stale-claim rule picks it up
        }
    }

    /** The server refused the result: kept aside in `rejected/` for inspection, not retried. */
    reject(claimed: ClaimedResult): void {
        this._move(claimed.file, "rejected", path.basename(claimed.file).replace(/\.claimed-\d+$/, ""));
    }

    private _move(file: string, folder: string, name: string): void {
        try {
            fs.mkdirSync(path.join(this.dir, folder), { recursive: true, mode: 0o700 });
            fs.renameSync(file, path.join(this.dir, folder, name));
        } catch {
            // best effort
        }
    }
}
