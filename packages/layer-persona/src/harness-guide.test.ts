import { describe, it, expect } from "vitest";
import {
  harnessGuideService,
  harnessGuideProvider,
  manifest,
} from "./harness-guide.js";

describe("@persona/harness-guide 契约", () => {
  it("服务定义归属 Persona 层", () => {
    expect(harnessGuideService.id).toBe("@persona/harness-guide");
    expect(harnessGuideService.layer).toBe("persona");
  });

  it("provider 与 manifest 注册正确", () => {
    expect(harnessGuideProvider.service).toBe(harnessGuideService);
    expect(manifest.provides).toContain(harnessGuideService);
    expect(manifest.consumes[0]?.id).toBe("@orchestration/workflow-engine");
  });
});