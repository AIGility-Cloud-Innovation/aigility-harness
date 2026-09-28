import { useEffect, useRef } from 'react'

export interface N3 {
  id: string
  name: string
  group: string
  color: string
  val: number
  tip: string
}

export interface L3 {
  source: string
  target: string
  rel: string
}

interface TwinGraph3DProps {
  nodes: N3[]
  links: L3[]
  onPick: (node: N3 | null) => void
  fill?: boolean
}

export function TwinGraph3D({ nodes, links, onPick, fill }: TwinGraph3DProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onPickRef = useRef(onPick)

  useEffect(() => {
    onPickRef.current = onPick
  })

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | null = null

    void (async () => {
      const [{ default: ForceGraph3D }, THREE, { default: SpriteText }] = await Promise.all([
        import('3d-force-graph'),
        import('three'),
        import('three-spritetext'),
      ])
      const container = containerRef.current
      if (disposed || !container) return

      const graph = new ForceGraph3D(container, { controlType: 'orbit' })
        .backgroundColor('#0b1220')
        .width(container.clientWidth)
        .height(container.clientHeight || 520)
        .graphData({ nodes: nodes as never[], links: links as never[] })
        .nodeRelSize(4)
        .nodeVal('val' as never)
        .nodeLabel((node) => {
          const item = node as N3
          return `<div style="font-size:12px;padding:4px 8px"><b>${item.name}</b><br/><span style="opacity:.7">${item.tip}</span></div>`
        })
        .nodeThreeObject((node: N3) => {
          const item = node as N3
          const group = new THREE.Group()
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(item.id === 'twin' ? 7 : 3.4, 20, 20),
            new THREE.MeshLambertMaterial({
              color: item.color,
              emissive: item.color,
              emissiveIntensity: item.id === 'twin' ? 0.55 : 0.3,
            }),
          )
          group.add(sphere)
          const sprite = new SpriteText(item.name)
          sprite.color = '#e2e8f0'
          sprite.textHeight = item.id === 'twin' ? 5 : 3.2
          sprite.position.set(0, item.id === 'twin' ? -11 : -7, 0)
          group.add(sprite)
          return group
        })
        .linkColor(() => 'rgba(148,163,184,0.35)')
        .linkWidth(0.6)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleWidth(1.6)
        .linkDirectionalParticleSpeed(0.004)
        .linkDirectionalParticleColor(() => '#60a5fa')
        .enableNodeDrag(false)
        .onNodeClick((node) => onPickRef.current(node as N3))
        .onBackgroundClick(() => onPickRef.current(null))

      const scene = (graph as unknown as { scene: () => import('three').Scene }).scene()
      scene.add(new THREE.AmbientLight('#ffffff', 1.6))
      const directionalLight = new THREE.DirectionalLight('#ffffff', 1.2)
      directionalLight.position.set(120, 160, 200)
      scene.add(directionalLight)

      const controls = (graph as unknown as {
        controls: () => { autoRotate: boolean; autoRotateSpeed: number }
      }).controls()
      controls.autoRotate = true
      controls.autoRotateSpeed = 0.7
      graph.cameraPosition({ x: 0, y: 30, z: 300 })

      const resize = () => graph
        .width(container.clientWidth)
        .height(container.clientHeight || 520)
      window.addEventListener('resize', resize)
      cleanup = () => {
        window.removeEventListener('resize', resize)
        ;(graph as unknown as { pauseAnimation: () => void }).pauseAnimation()
        container.innerHTML = ''
      }
      if (disposed) cleanup()
    })()

    return () => {
      disposed = true
      cleanup?.()
    }
  }, [nodes.length, links.length])

  return (
    <div
      ref={containerRef}
      className={fill ? 'h-full w-full' : 'h-[520px] w-full overflow-hidden rounded-xl'}
    />
  )
}
