import { readFile } from "node:fs/promises";
import type { AttemptRef, RoomPolicy } from "../harness-contracts/domain.ts";
import { ImageRefSchema } from "../harness-contracts/domain.ts";
import { canonicalJson, sha256 } from "../harness-contracts/validation.ts";
import { command } from "./process.ts";
import { imageProfile, workerArchitecture, type WorkerArchitecture } from "./images.ts";

export const SANDBOX_SCRIPT = new URL("../../workers/sandbox_ops.py", import.meta.url);
export function resourceName(owner: string, ref: AttemptRef): string {
  return `jarvis-${owner}-${sha256(canonicalJson(ref)).slice(0, 32)}`;
}

export class Docker {
  readonly binary: string;
  readonly owner: string;
  constructor(binary: string, owner: string) { this.binary = binary; this.owner = owner; }

  async available(): Promise<WorkerArchitecture> {
    const context = await command(this.binary, ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]);
    if (context.code !== 0 || !String(JSON.parse(context.stdout)).startsWith("unix://")) throw new Error("Worker requires a local Unix-socket Docker context");
    const info = await command(this.binary, ["info", "--format", "{{json .}}"]);
    if (info.code !== 0) throw new Error("Docker daemon unavailable");
    const parsed = JSON.parse(info.stdout);
    if (parsed.OSType !== "linux" || parsed.CgroupVersion !== "2" || !parsed.SecurityOptions?.some((s: string) => s.startsWith("name=seccomp"))) {
      throw new Error("Docker requires Linux cgroup v2 and default seccomp enforcement");
    }
    return workerArchitecture(parsed.Architecture);
  }

  async inspect(name: string): Promise<any | null> {
    const result = await command(this.binary, ["container", "inspect", name], { maxBytes: 131_072 });
    if (result.code !== 0) {
      if (/No such (object|container)/i.test(result.stderr)) return null;
      throw new Error("Docker container inspection unavailable");
    }
    return JSON.parse(result.stdout)[0];
  }

  assertOwned(container: any, ref: AttemptRef): void {
    const labels = container.Config?.Labels;
    if (labels?.["ai.jarvis.owner"] !== this.owner || labels?.["ai.jarvis.attempt"] !== sha256(canonicalJson(ref))) {
      throw new Error("Docker resource ownership mismatch");
    }
  }

  async create(ref: AttemptRef, policy: RoomPolicy, signal: AbortSignal, wallTimeMs = policy.runBudget.maxWallTimeMs): Promise<string> {
    const p = policy.sandbox;
    if (!Number.isSafeInteger(wallTimeMs) || wallTimeMs < 1 || wallTimeMs > 3_600_000) throw new Error("Invalid sandbox lifetime bound");
    if (p.image === null) throw new Error("Worker image is not configured");
    ImageRefSchema.parse(p.image);
    const architecture = await this.available();
    const profile = imageProfile(p.image);
    if (profile.architecture && profile.architecture !== architecture) throw new Error("Worker image pin does not match the Docker engine architecture; select the matching platform pin");
    const image = await command(this.binary, ["image", "inspect", p.image]);
    if (image.code !== 0) throw new Error("Pinned worker image must be explicitly pulled before execution");
    const imageConfig = JSON.parse(image.stdout)[0];
    if (imageConfig.Os !== "linux" || Object.keys(imageConfig.Config?.Volumes ?? {}).length) throw new Error("Worker image must be Linux with no declared host volumes");
    if (imageConfig.Architecture !== architecture) throw new Error("Worker image architecture must match the Docker engine; automatic emulation is not enabled");
    const workspace = `/workspace:rw,nosuid,nodev,${profile.coding ? "exec" : "noexec"},size=${p.workspaceMiB}m,uid=65532,gid=65532,mode=0700`;
    const temporary = "/tmp:rw,nosuid,nodev,noexec,size=16m,uid=65532,gid=65532,mode=0700";
    const name = resourceName(this.owner, ref);
    const result = await command(this.binary, ["create", "--pull=never", "--name", name,
      "--label", `ai.jarvis.owner=${this.owner}`, "--label", `ai.jarvis.attempt=${sha256(canonicalJson(ref))}`,
      "--network=none", "--user=65533:65533", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
      "--cpus", String(p.cpus), "--memory", `${p.memoryMiB}m`, "--memory-swap", `${p.memoryMiB}m`,
      "--pids-limit", String(p.pidsLimit), "--ipc=private", "--cgroupns=private", "--init", "--restart=no",
      "--ulimit", "nofile=256:256", "--ulimit", "core=0:0", "--log-driver=none",
      "--tmpfs", workspace, "--tmpfs", temporary,
      "--workdir", "/", "--entrypoint", "/usr/bin/env", p.image,
      "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/workspace", "LANG=C.UTF-8",
      "python3", "-I", "-S", "-c", `import time; time.sleep(${wallTimeMs / 1000})`], { signal });
    if (result.code !== 0 || !/^[a-f0-9]{64}$/.test(result.stdout.trim())) throw new Error("Docker sandbox creation failed");
    const container = await this.inspect(name);
    this.assertOwned(container, ref);
    const host = container.HostConfig;
    if (host.NetworkMode !== "none" || host.Privileged || !host.ReadonlyRootfs || host.Binds?.length || host.Devices?.length ||
        host.PidMode || host.IpcMode !== "private" || host.CgroupnsMode !== "private" || host.PortBindings && Object.keys(host.PortBindings).length ||
        host.Memory !== p.memoryMiB * 1_048_576 || host.MemorySwap !== host.Memory || host.PidsLimit !== p.pidsLimit ||
        host.NanoCpus !== p.cpus * 1e9 || host.CapDrop?.join() !== "ALL" || host.CapAdd?.length ||
        !host.SecurityOpt?.includes("no-new-privileges:true") || container.Config.User !== "65533:65533" ||
        container.Mounts?.length || container.Config.Volumes && Object.keys(container.Config.Volumes).length ||
        canonicalJson(host.Tmpfs) !== canonicalJson({ "/workspace": workspace.slice(11), "/tmp": temporary.slice(5) })) {
      throw new Error("Docker sandbox controls did not match policy");
    }
    const start = await command(this.binary, ["start", name], { signal });
    if (start.code !== 0) throw new Error("Docker sandbox could not start");
    let probe;
    try { probe = await this.operation(name, { op: "probe", coding: profile.coding }, { signal }); }
    catch { throw new Error(profile.coding ? "Coding image requires working Python 3.10+, Node 24, npm, C/C++ compiler and make" : "Worker image requires working Python 3.10+ (python3 on PATH)"); }
    const cpu = String(probe.value.cpu).split(" ").map(Number);
    if (probe.value.uid !== 65532 || probe.value.noNewPrivs !== "1" || probe.value.seccomp !== "2" ||
        !/^0+$/.test(probe.value.caps) || Number(probe.value.memory) !== p.memoryMiB * 1_048_576 ||
        probe.value.swap !== "0" || Number(probe.value.pids) !== p.pidsLimit || cpu[0] / cpu[1] !== p.cpus ||
        probe.value.workspaceNoexec !== !profile.coding || probe.value.temporaryNoexec !== true) {
      throw new Error("Docker kernel resource/security enforcement probe failed");
    }
    return container.Id;
  }

  async operation(name: string, request: Record<string, unknown>, options: {
    maxBytes?: number; timeoutMs?: number; signal?: AbortSignal;
  } = {}): Promise<{ value: any; output: string; code: number }> {
    const script = await readFile(SANDBOX_SCRIPT, "utf8");
    const result = await command(this.binary, ["exec", "-i", "--user=65532:65532", "--workdir=/workspace", name, "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin",
      "HOME=/workspace", "LANG=C.UTF-8", "python3", "-I", "-S", "-c", script], {
      ...options, input: JSON.stringify(request),
    });
    if (request.op === "check") return { value: null, output: result.stderr, code: result.code };
    if (result.code !== 0) throw new Error("Sandbox operation rejected (path, resource or process boundary)");
    return { value: JSON.parse(result.stdout), output: result.stderr, code: result.code };
  }

  async stop(ref: AttemptRef): Promise<boolean> {
    const name = resourceName(this.owner, ref);
    let container = await this.inspect(name);
    if (!container) return true;
    this.assertOwned(container, ref);
    if (container.State.Running) await command(this.binary, ["kill", name]);
    container = await this.inspect(name);
    if (container?.State.Running) return false;
    const removed = await command(this.binary, ["rm", "-v", name]);
    return (removed.code === 0 || !await this.inspect(name)) && !await this.inspect(name);
  }
}
