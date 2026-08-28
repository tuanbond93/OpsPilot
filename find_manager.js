require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function findManager() {
  console.log("Searching for MANAGER in MB03...");
  
  // Find member with role MANAGER and scope REGION MB03
  const { data: scopes, error: scopesErr } = await supabase
    .from('telegram_user_scopes')
    .select('*, telegram_pilot_members!inner(*)')
    .eq('scope_type', 'REGION')
    .eq('scope_code', 'MB03');
    
  if (scopesErr) {
    console.error("Error fetching scopes:", scopesErr);
    return;
  }
  
  const managers = scopes.filter(s => s.telegram_pilot_members.role === 'MANAGER');
  console.log("Found managers:", JSON.stringify(managers, null, 2));
}

findManager();
