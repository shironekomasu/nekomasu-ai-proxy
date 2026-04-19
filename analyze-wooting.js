const puppeteer = require('puppeteer');

// Wooting 使用 TWD 作為台灣區的顯示貨幣
// 這些數字 ($xxx) 看起來是 TWD，不是 USD！
// 從 DOM 分析來看：
//   Wooting 80HE Module (主機) = $4,952
//   80HE Plastic Case = $1,118  (PCR 塑料版)
//   80HE PCR Plastic (discount) = $319.20
//   Keycaps (45070...) = $1,278.40
//   Total = $6,549.60 (這是整個 bundle 的組合價格)
// 
// 問題：DOM 沒有 [role=radiogroup]，Wooting 用 custom react components
// 我們需要找到 URL query 參數的規律

(async () => {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();
    
    // Intercept API calls
    const apiData = [];
    page.on('response', async (res) => {
        const url = res.url();
        if (res.status() === 200 && (url.includes('/api/') || url.includes('products.json') || url.includes('cart.js'))) {
            try {
                const body = await res.text();
                if (body.length < 20000) apiData.push({ url: url.replace('https://wooting.io', '').substring(0, 100), body: body.substring(0, 500) });
            } catch {}
        }
    });
    
    await page.goto('https://wooting.io/configurator/wooting-80he?keycaps=45070587101407&product=module&switches=none', { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    
    // Find the total price / cart summary element
    const summary = await page.evaluate(() => {
        // Look for the cart total or the configurator summary sidebar
        const allSpans = Array.from(document.querySelectorAll('span, h1, h2, h3, h4, p, div'))
            .filter(e => e.children.length === 0 && e.innerText)
            .map(e => e.innerText.trim())
            .filter(t => t.includes('$') && t.length < 30);
        return allSpans;
    });
    console.log('All price strings:', JSON.stringify([...new Set(summary)]));
    
    // Find option buttons (Wooting uses custom React)
    const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, [role="button"]'))
            .map(b => ({ text: (b.innerText || '').trim().substring(0, 50), cls: b.className.substring(0, 80) }))
            .filter(b => b.text.length > 0 && b.text.length < 50);
    });
    console.log('Buttons:', JSON.stringify(buttons.slice(0, 20), null, 2));
    
    // Click on different product options and capture URL changes
    console.log('Current URL:', page.url());
    
    // Navigate to plastic case version
    await page.goto('https://wooting.io/configurator/wooting-80he?keycaps=none&product=plastic', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));
    
    const prices2 = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('span, p'))
            .filter(e => e.children.length === 0 && e.innerText)
            .map(e => e.innerText.trim())
            .filter(t => t.match(/\$[0-9,]+/));
    });
    console.log('Plastic case prices:', JSON.stringify([...new Set(prices2)].slice(0, 10)));
    
    await browser.close();
    console.log('\nAPI calls captured:', JSON.stringify(apiData, null, 2));
})().catch(e => console.error('Error:', e.message));
