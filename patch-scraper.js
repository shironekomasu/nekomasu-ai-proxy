const fs = require('fs');
let content = fs.readFileSync('services/scraper.js', 'utf8');

// Fix 1: upgrade waitUntil  
content = content.replace(
  "waitUntil: 'domcontentloaded', timeout: 30000",
  "waitUntil: 'networkidle2', timeout: 35000"
);

// Fix 2: reduce manual wait
content = content.replace(/await new Promise\(r => setTimeout\(r, 3000\)\);[^\n]+/,
  'await new Promise(r => setTimeout(r, 1500)); // 等 React 渲染完成'
);

fs.writeFileSync('services/scraper.js', content, 'utf8');
console.log('scraper.js patched. Length:', content.length);
