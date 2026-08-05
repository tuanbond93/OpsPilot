// Customer Tier & B2B Partner Configuration
export interface CustomerConfig {
  id: string;
  name: string;
  tier: "B2B_VIP" | "B2B_STANDARD" | "RETAIL";
  priorityWeight: number;
}

export const CUSTOMERS: CustomerConfig[] = [];
