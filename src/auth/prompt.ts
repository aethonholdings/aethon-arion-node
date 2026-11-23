import * as readline from "readline";

let piped: AsyncIterator<string> | null = null;

/**
 * Reads one line from the terminal; with `hidden`, the typed characters are not echoed. When stdin is not a terminal
 * (a pipe), the next line of input is read, so the commands can be scripted.
 */
export async function prompt(question: string, hidden: boolean = false): Promise<string> {
    if (!process.stdin.isTTY) {
        // one reader for the whole process: a reader per question would consume the lines meant for later questions
        if (!piped) piped = readline.createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
        process.stdout.write(question + "\n");
        const line = await piped.next();
        return line.done ? "" : String(line.value).trim();
    }
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        if (hidden) {
            // echo the question, then nothing of what is typed
            (rl as any)._writeToOutput = (text: string) => {
                if (text.startsWith(question)) (rl as any).output.write(question);
                else if (text.includes("\n") || text.includes("\r")) (rl as any).output.write("\n");
            };
        }
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}
