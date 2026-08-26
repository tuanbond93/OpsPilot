import { RillnetConnector } from "./index";

export type RillnetCustomer = { customerId: string; customerName: string; customerCode: string };

const CACHE_TTL_MS = 5 * 60_000;
let cached: { expiresAt: number; byOrderCode: Map<string, RillnetCustomer> } | null = null;
let pending: Promise<Map<string, RillnetCustomer>> | null = null;
let lastMissRefreshAt = 0;

async function refreshCustomerCache() {
  pending ||= new RillnetConnector().fetchSnapshot().then((snapshot) => {
    const byOrderCode = new Map(snapshot.orders.map((order) => [order.orderCode.toUpperCase(), {
      customerId: order.customerId,
      customerName: order.customerName,
      customerCode: order.customerCode,
    }]));
    cached = { expiresAt: Date.now() + CACHE_TTL_MS, byOrderCode };
    return byOrderCode;
  }).finally(() => { pending = null; });
  return pending;
}

export async function getRillnetCustomers(orderCodes: string[]): Promise<Record<string, RillnetCustomer>> {
  const requested = new Set(orderCodes.map((code) => code.trim().toUpperCase()).filter(Boolean));
  if (!requested.size) return {};
  const usedExistingCache = Boolean(cached && cached.expiresAt > Date.now());
  let lookup = usedExistingCache ? cached!.byOrderCode : await refreshCustomerCache();
  const hasMissingOrders = [...requested].some((code) => !lookup.has(code));
  if (usedExistingCache && hasMissingOrders && Date.now() - lastMissRefreshAt >= 15_000) {
    lastMissRefreshAt = Date.now();
    lookup = await refreshCustomerCache();
  }
  return Object.fromEntries([...requested].flatMap((code) => {
    const customer = lookup?.get(code);
    return customer ? [[code, customer]] : [];
  }));
}
