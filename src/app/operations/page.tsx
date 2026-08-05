import { RillnetConnector } from "@/connectors/rillnet";
import { aggregateIncidents, type Incident } from "@/engine/incident";
import { createAdminClient, IncidentRepository } from "@/connectors/supabase";

export const dynamic = "force-dynamic";

async function getOperationsData(): Promise<Incident[]> {
  // Strategy 1: Read from Supabase DB server-side
  try {
    const dbClient = createAdminClient();
    const repo = new IncidentRepository(dbClient);
    const dbIncidents = await repo.getOpenIncidents();

    if (dbIncidents.length > 0) {
      return dbIncidents.map((inc) => ({
        incidentId: inc.id,
        incidentKey: inc.incident_key,
        warehouseId: inc.warehouse_id,
        warehouseName: inc.warehouse_name || "Kho chưa xác định",
        reasonCode: inc.reason_code as any,
        reasonName: inc.reason_name,
        status: inc.status as any,
        priorityScore: inc.priority_score,
        firstDetectedAt: inc.first_detected_at,
        lastDetectedAt: inc.last_detected_at,
        affectedOrderCount: 0,
        sampleOrderCodes: [],
        averageAgeHours: null,
        maximumAgeHours: null,
        oldestOrderCode: null,
      }));
    }
  } catch {
    // Fallback to server-side live snapshot evaluation
  }

  // Strategy 2: Server-side live calculation fallback
  try {
    const connector = new RillnetConnector();
    const snapshotResult = await connector.fetchSnapshot();
    return aggregateIncidents(snapshotResult.orders);
  } catch {
    return [];
  }
}

export default async function OperationsPage() {
  const incidents = await getOperationsData();

  const totalOpenIncidents = incidents.length;
  const totalAffectedOrders = incidents.reduce((sum, inc) => sum + inc.affectedOrderCount, 0);
  const totalWarehouses = new Set(incidents.map((inc) => inc.warehouseId)).size;
  const highPriorityCount = incidents.filter((inc) => inc.priorityScore >= 40).length;

  const top20Incidents = incidents.slice(0, 20);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 max-w-7xl mx-auto space-y-8">
      <header className="border-b border-slate-800 pb-4">
        <h1 className="text-2xl font-bold text-slate-100">OpsPilot Operations Room</h1>
        <p className="text-xs text-slate-400">Server-side persisted operational memory & active incidents</p>
      </header>

      {/* 4 KPI Cards */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
          <span className="text-xs text-slate-400 uppercase tracking-wider block font-semibold">Open Incidents</span>
          <span className="text-3xl font-extrabold text-blue-400">{totalOpenIncidents.toLocaleString()}</span>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
          <span className="text-xs text-slate-400 uppercase tracking-wider block font-semibold">Affected Orders</span>
          <span className="text-3xl font-extrabold text-indigo-400">{totalAffectedOrders.toLocaleString()}</span>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
          <span className="text-xs text-slate-400 uppercase tracking-wider block font-semibold">Warehouses</span>
          <span className="text-3xl font-extrabold text-amber-400">{totalWarehouses}</span>
        </div>
        <div className="bg-slate-900 border border-slate-800 p-4 rounded-xl">
          <span className="text-xs text-slate-400 uppercase tracking-wider block font-semibold">High Priority</span>
          <span className="text-3xl font-extrabold text-rose-400">{highPriorityCount}</span>
        </div>
      </section>

      {/* Top 20 Priority Incidents Table */}
      <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="font-semibold text-slate-200">Top 20 Highest Priority Incidents</h2>
          <span className="text-xs text-slate-500">Sorted by Priority Score</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-800/60 uppercase text-slate-400 border-b border-slate-800">
              <tr>
                <th className="p-3">Warehouse</th>
                <th className="p-3">Reason</th>
                <th className="p-3 text-right">Affected Orders</th>
                <th className="p-3 text-right">Max Age (Hours)</th>
                <th className="p-3 text-right">Priority</th>
                <th className="p-3 text-right">Last Detected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/40">
              {top20Incidents.map((inc) => (
                <tr key={inc.incidentId} className="hover:bg-slate-800/30">
                  <td className="p-3 font-medium text-slate-200">{inc.warehouseName}</td>
                  <td className="p-3">
                    <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">
                      {inc.reasonName}
                    </span>
                  </td>
                  <td className="p-3 text-right font-mono font-bold text-indigo-400">{inc.affectedOrderCount}</td>
                  <td className="p-3 text-right font-mono text-amber-300">
                    {inc.maximumAgeHours !== null ? `${inc.maximumAgeHours}h` : "N/A"}
                  </td>
                  <td className="p-3 text-right font-mono font-bold text-rose-400">{inc.priorityScore}</td>
                  <td className="p-3 text-right text-slate-400">
                    {inc.lastDetectedAt ? new Date(inc.lastDetectedAt).toLocaleTimeString() : "N/A"}
                  </td>
                </tr>
              ))}
              {top20Incidents.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-6 text-center text-slate-500">
                    No active incidents detected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
