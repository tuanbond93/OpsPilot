const fs = require('fs');
let ns = fs.readFileSync('src/services/impl/NotificationService.ts', 'utf8');

if (!ns.includes('registerProvider')) {
  ns = ns.replace(/getProvider\(name: string\): NotificationProvider \| undefined \{/, 
  `registerProvider(provider: NotificationProvider): void {
    this.providers.set(provider.name().toLowerCase(), provider);
  }

  getProvider(name: string): NotificationProvider | undefined {`);
  fs.writeFileSync('src/services/impl/NotificationService.ts', ns);
}

// In the test, I replaced `dispatcher.registerProvider` with `((dispatcher as any).providers || dispatcher).registerProvider` using a regex but it was commented out in the previous script. Let's make sure it's not broken.
