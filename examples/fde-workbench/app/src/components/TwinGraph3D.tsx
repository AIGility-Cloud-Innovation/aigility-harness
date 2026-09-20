import { useEffect, useRef } from 'react'

/** 3D 孪生全景：实例级关系网（three.js 力导向图，动态加载不进首屏包） */

export interface N3 {
  id: string
  name: string
  group: string
  color: string
  /** 节点大小权重 */
  val: number
  /** 悬停提示 */
  tip: string
}
export interface L3 { source: string; target: string; rel: string }

interface Props {
  nodes: N3[]
  links: L3[]
  onPick: (id: string | null) => void
  /** 撑满父容器（全屏模式） */
  fill?: boolean
}

export function TwinGraph3D({ nodes, links, onPick, fill }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    let cleanup: (() => void) | null = null
    ;(async () => {
      const [{ default: ForceGraph3D }, THREE, { default: SpriteText }] = await Promise.all([
        import('3d-force-graph'),
        import('three'),
        import('three-spritetext'),
      ])
      if (disposed || !ref.current) return
      const el = ref.current

      const graph = new ForceGraph3D(el, { controlType: 'orbit' })
        .backgroundColor('#0b1220')
        .width(el.clientWidth)
        .height(el.clientHeight || 480)
        .graphData({ nodes: nodes as never[], links: links as never[] })
        .nodeRelSize(4)
        .nodeVal('val' as never)
        .nodeLabel((n) => { const x = n as N3; return `<div style="font-size:12px;padding:4px 8px"><b>${x.name}</b><br/><span style="opacity:.7">${x.tip}</span></div>` })
        .nodeThreeObject((n) => {
          const x = n as N3
          const group = new THREE.Group()
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(x.id === 'twin' ? 7 : 3.4, 20, 20),
            new THREE.MeshLambertMaterial({ color: x.color, emissive: x.color, emissiveIntensity: x.id === 'twin' ? 0.55 : 0.3 }),
          )
          group.add(sphere)
          const sprite = new SpriteText(x.name)
          sprite.color = '#e2e8f0'
          sprite.textHeight = x.id === 'twin' ? 5 : 3.2
          ;(sprite as unknown as { position: { y: number } }).position.y = x.id === 'twin' ? -11 : -7
          group.add(sprite)
          return group
        })
        .linkColor(() => 'rgba(148,163,184,0.35)')
        .linkWidth(0.6)
        .linkDirectionalParticles(2)
        .linkDirectionalParticleWidth(1.6)
        .linkDirectionalParticleSpeed(0.004)
        .linkDirectionalParticleColor(() => '#60a5fa')
        .enableNodeDrag(false) // 关闭节点拖拽，避免旋转中点按触发库内部 dragend 竞态报错
        .onNodeClick((n) => { const x = n as N3; onPick(x.id === 'twin' ? null : x.id) })
        .onBackgroundClick(() => onPick(null))

      // 环境光 + 点光源，让球体有立体感
      const scene = (graph as unknown as { scene: () => import('three').Scene }).scene()
      scene.add(new THREE.AmbientLight('#ffffff', 1.6))
      const dl = new THREE.DirectionalLight('#ffffff', 1.2)
      dl.position.set(120, 160, 200)
      scene.add(dl)

      // 缓慢自转，呈现「活的孪生体」
      const controls = (graph as unknown as { controls: () => { autoRotate: boolean; autoRotateSpeed: number } }).controls()
      controls.autoRotate = true
      controls.autoRotateSpeed = 0.7

      graph.cameraPosition({ x: 0, y: 30, z: 300 })
      const onResize = () => graph.width(el.clientWidth).height(el.clientHeight || 480)
      window.addEventListener('resize', onResize)
      cleanup = () => {
        window.removeEventListener('resize', onResize)
        ;(graph as unknown as { pauseAnimation: () => void; _destructor?: () => void }).pauseAnimation()
        el.innerHTML = ''
      }
      if (disposed) cleanup()
    })()
    return () => { disposed = true; cleanup?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, links.length])

  return <div ref={ref} className={fill ? 'h-full w-full' : 'h-[480px] w-full overflow-hidden rounded-xl'} />
}
