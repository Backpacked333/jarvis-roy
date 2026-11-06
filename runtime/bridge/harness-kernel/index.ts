import type { HarnessKernelOptions, HarnessService } from "../harness-contracts/service.ts";
import { HarnessKernel } from "./kernel.ts";

export function createHarnessKernel(options: HarnessKernelOptions): HarnessService {
  return new HarnessKernel(options);
}
