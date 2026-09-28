declare module 'three' {
  export class Group {
    add(child: unknown): this
  }

  export class SphereGeometry {
    constructor(radius?: number, widthSegments?: number, heightSegments?: number)
  }

  export class Mesh {
    constructor(geometry?: unknown, material?: unknown)
  }

  export class MeshLambertMaterial {
    constructor(parameters?: {
      color?: unknown
      emissive?: unknown
      emissiveIntensity?: number
    })
  }

  export class AmbientLight {
    constructor(color?: unknown, intensity?: number)
  }

  export class DirectionalLight {
    constructor(color?: unknown, intensity?: number)
    position: { set(x: number, y: number, z: number): this }
  }

  export interface Scene {
    add(child: unknown): this
  }
}

declare module 'three-spritetext' {
  class SpriteText {
    constructor(text?: string)
    color: string
    textHeight: number
    position: { set(x: number, y: number, z: number): void }
  }

  export default SpriteText
}
