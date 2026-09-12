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
