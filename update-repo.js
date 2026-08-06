const fs = require('fs');

// 1. Update IDashboardRepository
let content = fs.readFileSync('src/repositories/interfaces/IDashboardRepository.ts', 'utf8');
content = content.replace(
  'getRecentPlannerReviewEvents(limit: number): Promise<any[]>;',
  'getRecentPlannerReviewEvents(limit: number): Promise<any[]>;\n  getRecentActionEvents(limit: number): Promise<any[]>;'
);
fs.writeFileSync('src/repositories/interfaces/IDashboardRepository.ts', content);

// 2. Update MockDashboardRepository
content = fs.readFileSync('src/repositories/mock/MockDashboardRepository.ts', 'utf8');
content = content.replace(
  'async getRecentPlannerReviewEvents(limit: number): Promise<any[]> { return []; }',
  'async getRecentPlannerReviewEvents(limit: number): Promise<any[]> { return []; }\n  async getRecentActionEvents(limit: number): Promise<any[]> { return []; }'
);
fs.writeFileSync('src/repositories/mock/MockDashboardRepository.ts', content);

// 3. Update SupabaseDashboardRepository
content = fs.readFileSync('src/repositories/supabase/SupabaseDashboardRepository.ts', 'utf8');
content = content.replace(
  'async getRecentPlannerReviewEvents(limit: number): Promise<any[]> {',
  'async getRecentActionEvents(limit: number): Promise<any[]> {\n    return this.executeQuery(() => this.client.from("notification_action_events").select("*").order("created_at", { ascending: false }).limit(limit), "notification_action_events");\n  }\n\n  async getRecentPlannerReviewEvents(limit: number): Promise<any[]> {'
);
fs.writeFileSync('src/repositories/supabase/SupabaseDashboardRepository.ts', content);
