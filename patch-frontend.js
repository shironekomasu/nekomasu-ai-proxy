const fs = require('fs');

// ── 1. Patch server.js: add supported sites whitelist before the quote endpoint ──
const serverPath = './server.js';
let server = fs.readFileSync(serverPath, 'utf8');

const WHITELIST_CODE = `
// ─── 支援網站白名單 ───
// 只有這些平台經過完整測試，能精準抓取商品與價格。
// 非白名單網站一律導向「人工報價」流程，避免錯誤估價。
const SUPPORTED_DOMAINS = [
    // 日本
    'amazon.co.jp', 'mercari.com', 'rakuten.co.jp', 'yahoo.co.jp',
    'suruga-ya.jp', 'yodobashi.com', 'biccamera.com', 'kakaku.com',
    'akibaoo.co.jp', 'amiami.com', 'animate.co.jp',
    // 韓國
    'coupang.com', 'gmarket.co.kr', '11st.co.kr',
    // 台灣/全球 Shopify 測試通過
    'wooting.io',
    // 歐美主流
    'amazon.com', 'amazon.de', 'amazon.fr', 'amazon.co.uk',
    'ebay.com', 'etsy.com',
];

function isSupportedSite(url) {
    try {
        const hostname = new URL(url).hostname.replace(/^www\\./, '');
        return SUPPORTED_DOMAINS.some(d => hostname === d || hostname.endsWith('.' + d));
    } catch { return false; }
}

`;

// Insert whitelist before the POST /api/quote endpoint
server = server.replace(
    "// ─── 主估價 API ───",
    WHITELIST_CODE + "// ─── 主估價 API ───"
);

// Add manual quote check at the top of the endpoint handler
server = server.replace(
    "        console.log(`\\n=== 🚀 [v2] 開始智能估價: ${url} ===`);",
    `        // 非支援網站 → 導向人工報價，不浪費爬蟲資源
        if (!isSupportedSite(url)) {
            console.log(\`[Server] Unsupported site, routing to manual quote: \${url}\`);
            return res.json({
                success: true,
                needsManualQuote: true,
                source_url: url,
                message: '此網站目前需要人工確認報價，我們將為您安排專人處理。',
            });
        }

        console.log(\`\\n=== 🚀 [v2] 開始智能估價: \${url} ===\`);`
);

fs.writeFileSync(serverPath, server, 'utf8');
console.log('✅ server.js patched with whitelist');

// ── 2. Patch home-intro.js ──
const frontendPath = '../public/js/plugins/content/home-intro.js';
let fe = fs.readFileSync(frontendPath, 'utf8');

// 2a. Add the manual quote card HTML right after the variant cards grid closing tag
const QUOTE_CARD_HTML = `
                    <!-- Manual Quote Card (for unsupported sites) -->
                    <div id="ai-manual-quote-card" class="mt-4 p-5 border border-amber-500/30 rounded-2xl bg-amber-50 dark:bg-amber-900/20 hidden">
                        <div class="flex items-start gap-3 mb-3">
                            <span class="text-2xl mt-0.5">📋</span>
                            <div>
                                <h4 class="font-bold text-sm text-amber-700 dark:text-amber-300">此網站需要人工報價</h4>
                                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">我們目前尚未完整支援此網站的自動估價。請填寫以下表單送出報價申請，店主確認後將為您親自更新訂單金額。</p>
                            </div>
                        </div>
                        <div class="space-y-3 mt-4">
                            <div>
                                <label class="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide">商品網址</label>
                                <div id="ai-quote-url" class="mt-1 text-xs text-indigo-600 dark:text-indigo-400 truncate font-mono bg-indigo-50 dark:bg-indigo-900/30 rounded-lg px-3 py-2"></div>
                            </div>
                            <div>
                                <label class="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wide">規格備註（選填）</label>
                                <textarea id="ai-quote-note" placeholder="例如：黑色 / XL 尺寸 / 我想要第三張圖那款..." rows="2" class="w-full mt-1 text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 resize-none outline-none focus:border-indigo-400 transition-colors placeholder-gray-400"></textarea>
                            </div>
                            <button id="ai-submit-quote-btn" class="w-full bg-amber-500 hover:bg-amber-600 text-white font-bold py-2.5 px-4 rounded-xl transition-all text-sm active:scale-95 shadow-sm">
                                📬 送出報價申請
                            </button>
                            <p class="text-[10px] text-center text-gray-400">通常 24 小時內回覆 · 完全免費詢問</p>
                        </div>
                    </div>`;

fe = fe.replace(
    "                    <!-- Variant Cards Grid for AI to trigger (Multi Variant Mode) -->",
    QUOTE_CARD_HTML + "\n\n                    <!-- Variant Cards Grid for AI to trigger (Multi Variant Mode) -->"
);

// 2b. Add needsManualQuote handler inside the fetch_proxy_quote tool call block,
// right before needsVariantSelection check
const MANUAL_QUOTE_HANDLER = `
                                // ─── 人工報價路由（非支援網站）───
                                if (quoteData.needsManualQuote) {
                                    stateEl.textContent = '📋 需要人工確認';
                                    replyEl.textContent = quoteData.message || '此網站需要人工確認報價。';
                                    
                                    const mqCard = container.querySelector('#ai-manual-quote-card');
                                    const mqUrl  = container.querySelector('#ai-quote-url');
                                    if (mqCard && mqUrl) {
                                        mqUrl.textContent = args.url;
                                        mqCard.classList.remove('hidden');
                                    }
                                    return; // 終止 AI 遞迴
                                }

`;

fe = fe.replace(
    "                                // >>> 客製化商品攔截機制 (Bypass Ollama Combinatorics) <<<",
    MANUAL_QUOTE_HANDLER + "                                // >>> 客製化商品攔截機制 (Bypass Ollama Combinatorics) <<<"
);

// 2c. Reset manual quote card on new search (inside container reset block)
fe = fe.replace(
    "container.querySelector('#ai-variant-cards-grid').classList.add('hidden');",
    "container.querySelector('#ai-variant-cards-grid').classList.add('hidden');\n            container.querySelector('#ai-manual-quote-card')?.classList.add('hidden');"
);

fs.writeFileSync(frontendPath, fe, 'utf8');
console.log('✅ home-intro.js patched with manual quote card + handler');
console.log('needsManualQuote handler present:', fe.includes('needsManualQuote') ? '✅' : '❌');
console.log('Manual quote card HTML present:', fe.includes('ai-manual-quote-card') ? '✅' : '❌');
