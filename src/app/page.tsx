export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center justify-center p-6">
      <div className="max-w-3xl w-full text-center space-y-6 bg-slate-900/60 border border-slate-800 rounded-2xl p-10 backdrop-blur shadow-2xl">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-semibold uppercase tracking-wider">
          Sprint 0 Initialized
        </div>
        
        <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-blue-400 via-indigo-300 to-slate-100 bg-clip-text text-transparent">
          OpsPilot
        </h1>
        
        <p className="text-slate-400 text-lg max-w-xl mx-auto leading-relaxed">
          AI Operations Copilot for Logistics. Foundation architecture established with Next.js App Router, React Query, Supabase, and Tailwind CSS.
        </p>

        <div className="pt-4 grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs text-slate-400">
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <span className="block font-semibold text-slate-200">Framework</span>
            Next.js App Router
          </div>
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <span className="block font-semibold text-slate-200">Language</span>
            TypeScript (Strict)
          </div>
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <span className="block font-semibold text-slate-200">Database</span>
            Supabase (PostgreSQL)
          </div>
          <div className="p-3 rounded-lg bg-slate-800/40 border border-slate-800">
            <span className="block font-semibold text-slate-200">Data Fetching</span>
            React Query + RSC
          </div>
        </div>
      </div>
    </main>
  );
}
