const fs = require('fs');

const frontendPath = '../public/js/plugins/content/home-intro.js';
let fe = fs.readFileSync(frontendPath, 'utf8');

const NEW_EVENT_LISTENER = `
        // Manual Quote Form Event
        const quoteBtn = container.querySelector('#ai-submit-quote-btn');
        if (quoteBtn) {
            quoteBtn.addEventListener('click', () => {
                const urlEl = container.querySelector('#ai-quote-url');
                const noteEl = container.querySelector('#ai-quote-note');
                if (urlEl && noteEl) {
                    const originalText = quoteBtn.innerHTML;
                    quoteBtn.innerHTML = '送出中...';
                    quoteBtn.disabled = true;
                    
                    // Fire and forget logging or navigation to admin proxy manually.
                    // For now, add it to cart directly with a 0 pricing and special flag,
                    // or navigate to a dedicated form. 
                    const proxyUrl = urlEl.textContent;
                    const note = noteEl.value;

                    cartStore.addItem({
                        id: 'proxy-manual-' + Date.now(),
                        name: '[人工報價申請] 代購商品',
                        price: 0,
                        image: 'https://placehold.co/150x150/amber/white?text=Quote',
                        proxyUrl: proxyUrl,
                        notes: note
                    });
                    
                    setTimeout(() => {
                        window.navigateTo('/checkout');
                    }, 500);
                }
            });
        }
`;

if (!fe.includes('quoteBtn.addEventListener')) {
    fe = fe.replace(
        "// Checkout Button Event",
        NEW_EVENT_LISTENER + "\n        // Checkout Button Event"
    );
    fs.writeFileSync(frontendPath, fe, 'utf8');
    console.log('✅ Manual quote button event listener patched.');
} else {
    console.log('⚠️ Manual quote button event listener already exists.');
}
