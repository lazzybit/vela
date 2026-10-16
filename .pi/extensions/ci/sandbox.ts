/**
 * Bubblewrap sandbox for the model's file and shell access.
 *
 * Every command runs inside `bwrap` with a cleared environment, isolated
 * namespaces (fresh `/proc`), no network, and only the needed read-only mounts,
 * so generated commands cannot reach the provider or GitHub credentials that
 * live in the Pi process. It fails closed: if `bwrap` cannot run, the
 * overridden tools report an error instead of running unsandboxed.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type {
  BashOperations,
  ExtensionAPI,
  ReadOperations,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createReadTool,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";

/** Fixed bwrap arguments; the workspace, cwd, and command are added per call. */
const commonBwrapArgs: string[] = [
  "--die-with-parent", "--new-session",
  "--unshare-user", "--unshare-pid", "--unshare-ipc",
  "--unshare-uts", "--unshare-net", "--unshare-cgroup-try",
  "--clearenv",
  "--setenv", "PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "--setenv", "HOME", "/tmp/home",
  "--setenv", "LANG", "C.UTF-8",
  "--setenv", "LC_ALL", "C.UTF-8",
  "--setenv", "TERM", "dumb",
  // Read-only system tree. Not `--ro-bind / /`, which would keep exposing the
  // agent dir and session files inside the sandbox.
  "--ro-bind", "/usr", "/usr",
  "--ro-bind", "/etc", "/etc",
  "--symlink", "usr/bin", "/bin",
  "--symlink", "usr/sbin", "/sbin",
  "--symlink", "usr/lib", "/lib",
  ...["/lib64", "/lib32"].filter(existsSync).flatMap((lib) => ["--ro-bind", lib, lib]),
  "--tmpfs", "/tmp", "--dir", "/tmp/home",
  "--dev", "/dev", "--proc", "/proc",
];

const ignoreData = (): void => {};

function runSandbox(
  command: string[],
  onData: (data: Buffer) => void,
  { workspace, cwd }: { workspace: string; cwd: string },
): Promise<{ exitCode: number | null; output: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bwrap",
      [
        ...commonBwrapArgs,
        // Read-only repo at the same absolute path, so a model-supplied path
        // resolves identically inside and outside the sandbox.
        "--ro-bind", workspace, workspace,
        "--chdir", cwd,
        "--", ...command,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const output: Buffer[] = [];
    child.stdout.on("data", (data: Buffer) => {
      output.push(data);
      onData(data);
    });
    child.stderr.on("data", ignoreData);
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, output: Buffer.concat(output) }));
  });
}

export function registerSandbox(pi: ExtensionAPI): void {
  const workspace = process.cwd();
  const options = { workspace, cwd: workspace };

  const bashOperations: BashOperations = {
    exec: async (command, cwd, { onData }) => {
      const { exitCode } = await runSandbox(["/usr/bin/bash", "-c", command], onData, { workspace, cwd });
      return { exitCode };
    },
  };

  const readOperations: ReadOperations = {
    // `cat`, not an in-process `fs.read`, keeps the read inside the sandbox.
    readFile: async (path) => {
      const { exitCode, output } = await runSandbox(["/usr/bin/cat", "--", path], ignoreData, options);
      if (exitCode !== 0) throw new Error(`cat exited with ${exitCode}`);
      return output;
    },
    access: async (path) => {
      const { exitCode } = await runSandbox(["/usr/bin/test", "-r", path], ignoreData, options);
      if (exitCode !== 0) throw new Error(`not readable inside sandbox: ${path}`);
    },
    // Only returns a MIME type, never contents, so an in-process sniff is safe.
    detectImageMimeType: detectSupportedImageMimeTypeFromFile,
  };

  pi.registerTool({
    ...createBashTool(workspace, {
      operations: bashOperations,
      exposeSessionEnvironment: false,
    }),
  });

  pi.registerTool({
    ...createReadTool(workspace, { operations: readOperations }),
  });

  // `!` commands typed by the user follow the same boundary.
  pi.on("user_bash", () => ({ operations: bashOperations }));
}
