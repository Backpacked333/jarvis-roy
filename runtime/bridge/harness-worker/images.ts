export const WORKER_IMAGES = {
  python: {
    amd64: "python@sha256:2986c55feb36e6cae00fa1fefb454283e4b33f35e75ff8bdd123b134130be301",
    arm64: "python@sha256:228390eced221ad2986a3dd77e10b1accca6ba8ceb36f1572de1b346a337cc1a",
  },
  coding: {
    amd64: "node@sha256:6b9d4ea31e614e29f364bf75758458731eb1e105b80c99667438dd6b3fe262e0",
    arm64: "node@sha256:0bab91d6a954a4a75de4a887edfda7386ed8711aa8b1eb5fb309ee0f0a2c544f",
  },
} as const;

export type WorkerArchitecture = "amd64" | "arm64";
export function workerArchitecture(value: string): WorkerArchitecture {
  if (["amd64", "x86_64"].includes(value)) return "amd64";
  if (["arm64", "aarch64"].includes(value)) return "arm64";
  throw new Error("Worker requires a verified Linux amd64 or arm64 Docker engine");
}

export function imageProfile(image: string): { coding: boolean; architecture: WorkerArchitecture | null } {
  for (const profile of ["python", "coding"] as const) {
    for (const architecture of ["amd64", "arm64"] as const) {
      if (WORKER_IMAGES[profile][architecture] === image) return { coding: profile === "coding", architecture };
    }
  }
  return { coding: false, architecture: null };
}
