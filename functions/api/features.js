/*
 * FilamentStock Extra Features
 * QR codes, Barcode scanning, 3MF drag‑and‑drop import
 *
 * This module is loaded as an ES‑module and attaches helpers to `window`.
 * It also exposes the imported libraries globally for the inline UI script.
 */

import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";

// expose the libraries for non‑module code (the huge inline script in index.html)
window.JSZip = JSZip;
window.QRCode = QRCode;

/**
 * Generate a QR code on the canvas with id="qrCanvas".
 * If `text` is omitted the default is `"FSPOOL-{id}"`.
 *
 * @param {string|number} id   Identifier used for the default text.
 * @param {string} [text]       Text to encode.
 */
window.generateQR = async (id, text) => {
    const canvas = document.getElementById("qrCanvas");
    if (!canvas) return;
    await QRCode.toCanvas(canvas, text ?? `FSPOOL-${id}`, { width: 180 });
};

/**
 * Centralised scanner / barcode handler.
 *
 * @param {string} input Raw scanner string.
 */
window.handleScannerInput = (input) => {
    if (!input) return;
    if (input.startsWith("FSPOOL-")) {
        const id = input.replace("FSPOOL-", "");
        console.log("Scanned spool", id);
        if (window.openUsageModal) window.openUsageModal(id);
    } else {
        console.log("Barcode scanned", input);
        if (window.lookupBarcode) window.lookupBarcode(input);
    }
};

/**
 * Parse a .3mf file and return basic information.
 *
 * @param {File} file The .3mf file.
 * @returns {Promise<{project:string, grams:number|null}>}
 */
window.parse3MF = async (file) => {
    const zip = await JSZip.loadAsync(file);
    const project = file.name;
    let grams = null;

    try {
        const cfg = await zip.file("Metadata/model_settings.config")?.async("text");
        if (cfg) {
            const match = cfg.match(/filament_used\s*=\s*([0-9.]+)/) ??
                cfg.match(/estimated_weight\s*=\s*([0-9.]+)/);
            if (match) grams = parseFloat(match[1]);
        }
    } catch (e) {
        console.warn("3MF parse failed", e);
    }
    return { project, grams };
};

/**
 * Initialise drag‑and‑drop handling for .3mf files.
 */
window.setup3mfDrop = () => {
    const drop = document.getElementById("drop-zone");
    if (!drop) return;

    const addDrag = () => drop.classList.add("drag");
    const rmDrag = () => drop.classList.remove("drag");

    drop.addEventListener("dragover", (e) => {
        e.preventDefault();
        addDrag();
    });
    drop.addEventListener("dragleave", rmDrag);
    drop.addEventListener("drop", async (e) => {
        e.preventDefault();
        rmDrag();

        const file = e.dataTransfer.files[0];
        if (!file?.name?.toLowerCase().endsWith(".3mf")) return;

        const data = await window.parse3MF(file);
        if (data.grams) {
            alert(`Detected ${data.grams} g from 3MF`);
            if (window.openUsageModal) openUsageModal(null, data.project, data.grams);
        } else {
            alert("Could not detect weight from 3MF");
        }
    });
};
