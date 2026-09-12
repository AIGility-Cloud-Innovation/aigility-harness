/** 内核引用 (由 appbase index.ts 注入; 避免模块直接依赖装配层) */
let adminKernel: {
  registry: {
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
