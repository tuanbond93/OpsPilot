
const URL = 'https://opspilot-tau-lyart.vercel.app/api/debug/yba-pilot-temp';

async function run() {
  console.log("1. BACKUP");
  const backupRes = await fetch(URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'BACKUP' })
  }).then(r => r.json());
  
  if (backupRes.error) {
    console.error("Backup failed:", backupRes.error);
    return;
  }
  console.log("BACKUP DATA:", JSON.stringify(backupRes, null, 2));
  
  const managerId = backupRes.member.id;
  const privateChatId = backupRes.member.private_chat_id;
  
  console.log("\n2. SET_EMPLOYEE");
  const setRes = await fetch(URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'SET_EMPLOYEE', managerId })
  }).then(r => r.json());
  console.log("Set employee:", setRes);
  
  console.log("\n3. TEST_ROUTING (YBA)");
  const testYba = await fetch(URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'TEST_ROUTING', province: 'Yên Bái', provinceCode: 'YBA', privateChatId })
  }).then(r => r.json());
  console.log("Test YBA:", JSON.stringify(testYba, null, 2));
  
  console.log("\n4. TEST_ROUTING (Non-YBA)");
  const testNonYba = await fetch(URL, {
    method: 'POST',
    body: JSON.stringify({ action: 'TEST_ROUTING', province: 'Hà Nội', provinceCode: 'HN', privateChatId })
  }).then(r => r.json());
  console.log("Test Non-YBA:", JSON.stringify(testNonYba, null, 2));
}

run();
