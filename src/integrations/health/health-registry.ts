import type { HealthStatus, ComponentHealth, HealthCheckable } from "./types";

export class HealthRegistry {
  private static checkers = new Map<string, HealthCheckable>();

  static register(checkable: HealthCheckable): void {
    this.checkers.set(checkable.name.toLowerCase(), checkable);
  }

  static unregister(name: string): void {
    this.checkers.delete(name.toLowerCase());
  }

  static getCheckers(): HealthCheckable[] {
    return Array.from(this.checkers.values());
  }

  static clear(): void {
    this.checkers.clear();
  }

  /**
   * Run health checks across all registered integrations
   */
  static async checkAll(): Promise<{
    overallStatus: HealthStatus;
    components: Record<string, ComponentHealth>;
    checkedAt: string;
  }> {
    const components: Record<string, ComponentHealth> = {};
    let overall: HealthStatus = "GREEN";

    const promises = Array.from(this.checkers.entries()).map(async ([name, checkable]) => {
      try {
        const result = await checkable.health();
        components[name] = result;
      } catch (err: any) {
        components[name] = {
          status: "RED",
          healthReason: `Health check error: ${err?.message || String(err)}`,
          lastSuccessAt: null,
          lastFailureAt: new Date().toISOString(),
          freshnessSeconds: null,
        };
      }
    });

    await Promise.all(promises);

    // Aggregate overall status:
    // If any component is RED, overall is RED.
    // Else if any component is YELLOW, overall is YELLOW.
    // Else if any component is UNKNOWN, overall is UNKNOWN (or GREEN if others green, let's say UNKNOWN if no RED/YELLOW).
    // Default is GREEN.
    let hasRed = false;
    let hasYellow = false;
    let hasUnknown = false;

    for (const comp of Object.values(components)) {
      if (comp.status === "RED") hasRed = true;
      else if (comp.status === "YELLOW") hasYellow = true;
      else if (comp.status === "UNKNOWN") hasUnknown = true;
    }

    if (hasRed) overall = "RED";
    else if (hasYellow) overall = "YELLOW";
    else if (hasUnknown) overall = "UNKNOWN";

    return {
      overallStatus: overall,
      components,
      checkedAt: new Date().toISOString(),
    };
  }
}
