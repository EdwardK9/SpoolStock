// scripts.js
// Sidebar open/close is now handled directly in index.html via openSidebar(cardEl)
// and closeSidebar(). The card elements have onclick="openSidebar(this)" set when
// they are rendered, so no DOMContentLoaded listener is needed here.

// You can still use this file for any additional features, e.g. scanner input:

window.handleScannerInput = function (input) {
    if (!input) return;
    if (input.startsWith("FSPOOL-")) {
        const id = input.replace("FSPOOL-", "");
        const card = document.querySelector(`[data-id="${id}"]`);
        if (card) openSidebar(card);
    }
};
