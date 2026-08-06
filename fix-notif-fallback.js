const fs = require('fs');

let ns = fs.readFileSync('src/services/impl/NotificationService.ts', 'utf8');

if (!ns.includes('import { ConsoleProvider }')) {
  ns = ns.replace('import { NotificationBuilder }', 'import { ConsoleProvider } from "../../notifications/providers/console";\nimport { NotificationBuilder }');
}

ns = ns.replace(/getProvider\(name: string\): NotificationProvider \| undefined \{[\s\S]*?return this\.providers\.get\(name\.toLowerCase\(\)\) \|\| this\.providers\.get\("console"\);\s*\}/, 
`getProvider(name: string): NotificationProvider {
    return this.providers.get(name.toLowerCase()) || this.providers.get("console") || new ConsoleProvider();
  }`);

// Also fix the check where it checks `if (!provider)`
ns = ns.replace(/if \(!provider\) \{[\s\S]*?\} else \{/, `if (!provider) {
        // Unreachable if fallback to ConsoleProvider is used, but keeping for safety
      } else {`);
fs.writeFileSync('src/services/impl/NotificationService.ts', ns);

