const fs = require('fs');

const frontendPath = '../public/js/plugins/content/home-intro.js';
let fe = fs.readFileSync(frontendPath, 'utf8');

const RENDERER_FIX = `
                                // >>> 客製化商品攔截機制 (直接支援 API 原生 Variants 或 AI 組合) <<<
                                const hasNativeVariants = quoteData.product?.variants && quoteData.product.variants.length > 0;
                                const hasAvailableGroups = quoteData.needsVariantSelection && quoteData.availableVariants;
                                
                                if (quoteData.success && (hasNativeVariants || hasAvailableGroups)) {
                                    stateEl.textContent = '✅ 抽取多種客製選項完成';
                                    replyEl.textContent = '我們偵測到了此商品具備多種規格組合！請直接點選您想要的卡片，系統會即時為您進行深入比價！';
                                    
                                    let combos = [];
                                    
                                    // 優先使用從 API 直接抓回來的原生 Variant 列表（精準度 100%）
                                    if (hasNativeVariants) {
                                        combos = quoteData.product.variants.map(v => ({
                                            title: v.name || v.spec || '預設規格',
                                            selected_options: [v.name || v.spec],
                                            exactPrice: v.price,
                                            exactCurrency: v.currency
                                        }));
                                    } 
                                    // 否則使用頁面元素嗅探出的人工組合
                                    else {
                                        combos = [ { title: "", selected_options: [] } ];
                                        const groupKeys = Object.keys(quoteData.availableVariants).slice(0, 2);
                                        for (const key of groupKeys) {
                                            const nextCombos = [];
                                            const vals = quoteData.availableVariants[key].slice(0, 20); // 提升上限到20 
                                            for (const c of combos) {
                                                for (const v of vals) {
                                                    const sep = c.title ? ' / ' : '';
                                                    nextCombos.push({
                                                        title: c.title + sep + v,
                                                        selected_options: [...c.selected_options, v]
                                                    });
                                                }
                                            }
                                            combos = nextCombos;
                                        }
                                        // 全排列若過大，截斷防當機
                                        if (combos.length > 30) combos = combos.slice(0, 30);
                                    }

                                    // Render Grid
                                    const grid = container.querySelector('#ai-variant-cards-grid');
                                    grid.innerHTML = ''; 

                                    combos.forEach(combo => {
                                        const el = document.createElement('div');
                                        el.className = 'p-4 border border-teal-500/30 rounded-xl bg-teal-50 dark:bg-teal-900/20 flex flex-col gap-3 transition-transform hover:-translate-y-1';
                                        
                                        const imgHtml = quoteData.product.image ? \`<img src="\${quoteData.product.image}" class="w-full h-24 object-cover rounded-lg">\` : '';
                                        
                                        // 若 API 直接回傳了各規格價格，直接顯示，否則 fallback 顯示總共的價格
                                        const displayPrice = combo.exactPrice 
                                            ? Math.round(combo.exactPrice) 
                                            : Math.round(quoteData.pricing.total_twd || 0);

                                        el.innerHTML = \`
                                            \${imgHtml}
                                            <div class="flex-1">
                                                <h4 class="font-bold text-sm leading-tight">\${quoteData.product.title}</h4>
                                                <div class="text-xs text-gray-500 my-1 font-bold">[\${combo.title}]</div>
                                                <div class="variant-price-display text-teal-600 dark:text-teal-400 font-bold mt-1 text-xs">預估起步：NT$ \${displayPrice.toLocaleString()}</div>
                                                <div class="text-[10px] text-gray-400 mt-0.5">via \${quoteData.tier_used || 'engine'}</div>
                                            </div>
                                            <button class="w-full mt-1 bg-teal-600 hover:bg-teal-700 text-white font-bold py-2 px-3 rounded-lg transition-colors text-xs select-variant-btn">
                                                獲取此規格最終售價
                                            </button>
                                        \`;

                                        const btnEl = el.querySelector('.select-variant-btn');
                                        // 傳進原始 quoteData 讓點擊驗證時可以使用
                                        btnEl.addEventListener('click', () => handleVariantHoverClick(btnEl, lastUserUrl, combo));
                                        grid.appendChild(el);
                                    });

                                    grid.classList.remove('hidden');
                                    return; // 終結 Agent 遞迴，不再返回給 Ollama 防止卡頓
                                }
`;

// Extract the old block to replace
const startIndex = fe.indexOf('// >>> 客製化商品攔截機制');
const endIndex = fe.indexOf('// 如果無規格，交回給 AI 產生結帳卡片');

if (startIndex > -1 && endIndex > -1) {
    const oldBlock = fe.substring(startIndex, endIndex);
    fe = fe.replace(oldBlock, RENDERER_FIX + '\n                                ');
    fs.writeFileSync(frontendPath, fe, 'utf8');
    console.log('✅ Render fix applied.');
} else {
    console.log('❌ Could not find block to replace.');
}
