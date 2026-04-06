// scripts.js

document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.spool-item').forEach(item => {
        item.addEventListener('click', () => {
            openSidebar(item);
        });
    });

    function openSidebar(spoolItem) {
        const sidebar = document.getElementById('sidebar');
        sidebar.classList.add('open');

        const detailList = document.getElementById('detail-list');
        detailList.innerHTML = '';

        // Extract details from the spool item
        const brand = spoolItem.getAttribute('data-brand') || 'N/A';
        const material = spoolItem.getAttribute('data-material') || 'N/A';
        const colorName = spoolItem.getAttribute('data-color-name') || 'N/A';
        const style = spoolItem.getAttribute('data-style') || 'N/A';
        const code = spoolItem.getAttribute('data-code') || 'N/A';
        const barcode = spoolItem.getAttribute('data-barcode') || 'N/A';
        const webAddress = spoolItem.getAttribute('data-web-address') || 'N/A';
        const weightCurrent = parseFloat(spoolItem.getAttribute('data-weight-current')) || 0;
        const totalPurchased = parseFloat(spoolItem.getAttribute('data-total-purchased')) || 0;

        // Create list items for details
        detailList.innerHTML += `
            <li><strong>Brand:</strong> ${brand}</li>
            <li><strong>Material:</strong> ${material}</li>
            <li><strong>Color Name:</strong> ${colorName}</li>
            <li><strong>Style:</strong> ${style}</li>
            <li><strong>Code:</strong> ${code}</li>
            <li><strong>Barcode:</strong> ${barcode}</li>
            <li><strong>Web Address:</strong> <a href="${webAddress}" target="_blank">${webAddress}</a></li>
            <li><strong>Weight Current (g):</strong> ${weightCurrent.toFixed(2)}</li>
            <li><strong>Total Purchased (kg):</strong> ${(totalPurchased / 1000).toFixed(2)}</li>
        `;

        // Fetch and display recent usage
        fetch('/api/usage')
            .then(res => res.json())
            .then(data => {
                const recentUsage = data.filter(u => u.filament_id == spoolItem.getAttribute('data-id')).slice(0, 5);
                if (recentUsage.length > 0) {
                    detailList.innerHTML += `<li><h3>Recent Usage</h3></li>`;
                }
                recentUsage.forEach(u => {
                    detailList.innerHTML += `
                        <li><strong>Project:</strong> ${u.project} · <strong>Grams Used:</strong> ${u.grams}</li>
                    `;
                });
            })
            .catch(error => console.error('Error fetching usage data:', error));
    }

    function closeSidebar() {
        document.getElementById('sidebar').classList.remove('open');
    }
});

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar.classList.contains('open')) {
        closeSidebar();
    } else {
        openSidebar(null);
    }
}
