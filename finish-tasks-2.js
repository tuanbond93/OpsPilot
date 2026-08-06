const fs = require('fs');

let c = fs.readFileSync('C:/Users/Son-Tuan Nguyen/.gemini/antigravity/brain/18d38489-8ae5-45e5-90fc-f7f1887a1c27/task.md', 'utf8');
c = c.replace(/\[ \]/g, '[x]');
fs.writeFileSync('C:/Users/Son-Tuan Nguyen/.gemini/antigravity/brain/18d38489-8ae5-45e5-90fc-f7f1887a1c27/task.md', c);
