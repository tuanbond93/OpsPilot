const fs = require('fs');

function replaceInFile(pathStr, replacer) {
  if (fs.existsSync(pathStr)) {
    let c = fs.readFileSync(pathStr, 'utf8');
    c = replacer(c);
    fs.writeFileSync(pathStr, c);
  }
}

replaceInFile('src/app/api/debug/incidents/[incidentId]/history/route.ts', c => {
  return c.replace(/const historyRepo = new \(dbClient\);/g, 'const historyRepo = RepositoryFactory.getIncidentHistoryRepository(dbClient);');
});

replaceInFile('src/app/api/debug/planner/[incidentId]/generate/route.ts', c => {
  let res = c.replace(/const historyRepo = new \(dbClient\);/g, 'const historyRepo = RepositoryFactory.getIncidentHistoryRepository(dbClient);');
  res = res.replace(/const exceptionRepo = new \(dbClient\);/g, 'const exceptionRepo = RepositoryFactory.getExceptionRepository(dbClient);');
  return res;
});

replaceInFile('src/app/api/debug/rootcause/[incidentId]/route.ts', c => {
  return c.replace(/const historyRepo = new \(dbClient\);/g, 'const historyRepo = RepositoryFactory.getIncidentHistoryRepository(dbClient);');
});

replaceInFile('src/jobs/sync-rillnet.ts', c => {
  let res = c.replace(/const historyRepo = RepositoryFactory\.getIncidentHistoryRepository\(dbClient\)\(dbClient\);/g, 'const historyRepo = RepositoryFactory.getIncidentHistoryRepository(dbClient);');
  return res;
});

