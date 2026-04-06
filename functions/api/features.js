
// ======================================================
// FilamentStock Extra Features
// QR codes, Barcode scanning, 3MF drag import
// ======================================================

import JSZip from "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";
import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";

window.generateQR = async function(id, text){
    const canvas = document.getElementById("qrCanvas");
    if(!canvas) return;
    await QRCode.toCanvas(canvas, text || ("FSPOOL-"+id), {width:180});
}

window.handleScannerInput = function(input){
    if(!input) return;

    if(input.startsWith("FSPOOL-")){
        const id = input.replace("FSPOOL-","");
        console.log("Scanned spool",id);
        if(window.openUsageModal) openUsageModal(id);
    }else{
        console.log("Barcode scanned",input);
        if(window.lookupBarcode) lookupBarcode(input);
    }
}

// ==========================================
// 3MF Parser
// ==========================================
window.parse3MF = async function(file){

    const zip = await JSZip.loadAsync(file);

    let grams = null;
    let project = file.name;

    try{
        const config = await zip.file("Metadata/model_settings.config").async("text");

        let match = config.match(/filament_used\s*=\s*([0-9.]+)/);

        if(!match){
            match = config.match(/estimated_weight\s*=\s*([0-9.]+)/);
        }

        if(match){
            grams = parseFloat(match[1]);
        }

    }catch(e){
        console.warn("3MF parse failed",e);
    }

    return {
        project,
        grams
    }
}

// ==========================================
// Drag and drop handler
// ==========================================
window.setup3mfDrop = function(){

    const drop = document.getElementById("drop-zone");

    if(!drop) return;

    drop.addEventListener("dragover",e=>{
        e.preventDefault();
        drop.classList.add("drag");
    });

    drop.addEventListener("dragleave",()=>{
        drop.classList.remove("drag");
    });

    drop.addEventListener("drop",async e=>{
        e.preventDefault();
        drop.classList.remove("drag");

        const file = e.dataTransfer.files[0];
        if(!file.name.endsWith(".3mf")) return;

        const data = await parse3MF(file);

        if(data.grams){
            alert(`Detected ${data.grams}g from 3MF`);
            if(window.openUsageModal){
                openUsageModal(null,data.project,data.grams);
            }
        }else{
            alert("Could not detect weight from 3MF");
        }
    });
}
