import { AppProvider, useStore } from '@/store/AppContext'
import { TopNav } from '@/components/TopNav'
import { Sidebar } from '@/components/Sidebar'
import { EmployeePanel } from '@/components/EmployeePanel'
import { Dashboard } from '@/sections/Dashboard'
import { Tasks } from '@/sections/Tasks'
import { DeliveryPage } from '@/sections/Delivery'
import { Modules } from '@/sections/Modules'
import { Performance } from '@/sections/Performance'
import { Deployments } from '@/sections/Deployments'
import { Leads } from '@/sections/Leads'
import { LeadDetail } from '@/sections/LeadDetail'
import { Proposals } from '@/sections/Proposals'
import { ProposalDetail } from '@/sections/ProposalDetail'
import { Contracts } from '@/sections/Contracts'
import { Channels } from '@/sections/Channels'
import { Knowledge } from '@/sections/Knowledge'
import { Mcp } from '@/sections/Mcp'
import { Ontology } from '@/sections/Ontology'
import { ImportData } from '@/sections/ImportData'
import { Audit } from '@/sections/Audit'
import { Login } from '@/sections/Login'
import { Toaster } from '@/components/ui/sonner'

function Main() {
  const { page, loggedIn } = useStore()
  if (!loggedIn) {
    return (
      <>
        <Login />
        <Toaster position="top-center" richColors />
      </>
    )
  }
  return (
    <div className="min-h-screen md:flex">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <TopNav />
        <main className="mx-auto max-w-[1120px] px-5 md:px-10 py-6 md:py-9 pb-12">
          {page.name === 'dashboard' && <Dashboard />}
          {page.name === 'tasks' && <Tasks />}
          {page.name === 'performance' && <Performance />}
          {page.name === 'leads' && <Leads />}
          {page.name === 'lead' && <LeadDetail id={page.id} />}
          {page.name === 'proposals' && <Proposals />}
          {page.name === 'proposal' && <ProposalDetail id={page.id} />}
          {page.name === 'contracts' && <Contracts />}
          {page.name === 'delivery' && <DeliveryPage />}
          {page.name === 'deployments' && <Deployments />}
          {page.name === 'channels' && <Channels />}
          {page.name === 'knowledge' && <Knowledge />}
          {page.name === 'modules' && <Modules />}
          {page.name === 'import' && <ImportData />}
          {page.name === 'audit' && <Audit />}
          {page.name === 'mcp' && <Mcp />}
          {page.name === 'ontology' && <Ontology />}
        </main>
        <footer className="hidden md:block border-t border-slate-200 py-4 text-center text-xs text-slate-400">
          TiMEM FDE 工作台 · 私有化部署 · 数据不出内网 · 演示数据
        </footer>
      </div>
      <EmployeePanel />
      <Toaster position="top-center" richColors />
    </div>
  )
}

export default function App() {
  return (
    <AppProvider>
      <Main />
    </AppProvider>
  )
}
