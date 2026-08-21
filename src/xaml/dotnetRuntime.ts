import { spawn } from "child_process";
import * as path from "path";
import { Readable } from "stream";

export const REQUIRED_DOTNET_MAJOR = 10;

export function hasRequiredDotnetRuntime(
  listRuntimesOutput: string,
  requiredMajor = REQUIRED_DOTNET_MAJOR
): boolean {
  return listRuntimesOutput
    .split(/\r?\n/)
    .some((line) => new RegExp(`^Microsoft\\.NETCore\\.App ${requiredMajor}\\.`).test(line.trim()));
}

export function getDotnetCandidates(
  env: NodeJS.ProcessEnv = process.env,
  architecture = process.arch
): string[] {
  const architectureRoot =
    env[`DOTNET_ROOT_${architecture === "ia32" ? "X86" : architecture.toUpperCase()}`];
  const candidates = [
    env.DOTNET_HOST_PATH,
    architectureRoot ? path.join(architectureRoot, "dotnet.exe") : undefined,
    env.DOTNET_ROOT ? path.join(env.DOTNET_ROOT, "dotnet.exe") : undefined,
    env.ProgramFiles ? path.join(env.ProgramFiles, "dotnet", "dotnet.exe") : undefined,
    "dotnet",
  ].filter((candidate): candidate is string => Boolean(candidate));

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function findCompatibleDotnet(
  candidates = getDotnetCandidates(),
  probe: (command: string) => Promise<string | undefined> = listDotnetRuntimes
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const runtimes = await probe(candidate);
    if (runtimes && hasRequiredDotnetRuntime(runtimes)) {
      return candidate;
    }
  }
  return undefined;
}

export interface RuntimeProbeProcess {
  readonly stdout: Readable;
  on(event: "error", listener: () => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
  kill(): boolean;
}

export type RuntimeProbeSpawner = (command: string) => RuntimeProbeProcess;

const spawnRuntimeProbe: RuntimeProbeSpawner = (command) =>
  spawn(command, ["--list-runtimes"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

export function listDotnetRuntimes(
  command: string,
  timeoutMs = 5000,
  spawnProbe: RuntimeProbeSpawner = spawnRuntimeProbe
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const child = spawnProbe(command);
    const finish = (value: string | undefined) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      }
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => finish(code === 0 ? stdout : undefined));
  });
}
