require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function testShadow() {
  console.log("Checking recent message_deliveries for SHADOW...");
  const { data, error } = await supabase
    .from('message_deliveries')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);
  
  if (error) console.error(error);
  console.log("Recent deliveries:", data);
}

testShadow();
