/** 内核引用 (由 appbase index.ts 注入; 避免模块直接依赖装配层) */
let adminKernel: {
  createContext(sessionId: string, callerLayer: string): unknown;
  registry: {
    resolve<TReq = unknown, TRes = unknown>(ref: {
      id: string;
      versionRange: string;
    }): Promise<
      | { ok: true; value: { execute(req: TReq, ctx: unknown): Promise<{ ok: boolean; value?: TRes; error?: string }> } }
      | { ok: false; error: string }
    >;
    listAllServices(): Array<{ service: unknown; providerName: string; state: unknown }>;
  };
} | null = null;

export function setAdminKernel(kernel: NonNullable<typeof adminKernel>): void {
  adminKernel = kernel;
}

export function getAdminKernel(): typeof adminKernel {
  return adminKernel;
}

/** 装配的 LayerPlugin manifests (框架层插件枚举的 provides/consumes 数据源) */
export interface AdminManifestLike {
  name: string;
  layer: string;
  description: string;
  version: string;
  provides: unknown[];
  consumes: unknown[];
}

let adminManifests: AdminManifestLike[] = [];

export function setAdminManifests(manifests: AdminManifestLike[]): void {
  adminManifests = manifests;
}

export function getAdminManifests(): AdminManifestLike[] {
  return adminManifests;
}
