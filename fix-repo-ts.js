const fs = require('fs');

let content = fs.readFileSync('src/repositories/supabase/SupabaseDashboardRepository.ts', 'utf8');

content = content.replace(/this\.executeMany\(([^)]+)\)/g, 'this.executeMany($1 as unknown as Promise<{ data: any[] | null; error: any }>)');

fs.writeFileSync('src/repositories/supabase/SupabaseDashboardRepository.ts', content);
