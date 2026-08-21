document.addEventListener("DOMContentLoaded", () => {
    const API_BASE = window.location.origin;

    // ═══════════════════════════════════════════════════════════
    // Dashboard Tab Switching
    // ═══════════════════════════════════════════════════════════
    const dashTabs = document.querySelectorAll(".dash-tab");
    const dashViews = document.querySelectorAll(".dash-view");

    dashTabs.forEach(tab => {
        tab.addEventListener("click", () => {
            dashTabs.forEach(t => t.classList.remove("active"));
            dashViews.forEach(v => { v.classList.add("hidden"); v.classList.remove("active"); });
            tab.classList.add("active");
            const view = document.getElementById(tab.dataset.target);
            view.classList.remove("hidden");
            setTimeout(() => view.classList.add("active"), 10);

            if (tab.dataset.target === "explorer-view" && !explorerLoaded) initExplorer();
            if (tab.dataset.target === "insights-view" && !insightsLoaded) initInsights();
        });
    });

    // Inner tabs (Upload / URL)
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById(tab.dataset.target).classList.add("active");
        });
    });

    // ═══════════════════════════════════════════════════════════
    // 1. Classifier Tester
    // ═══════════════════════════════════════════════════════════
    const dropZone      = document.getElementById("drop-zone");
    const fileInput     = document.getElementById("file-input");
    const browseBtn     = document.getElementById("browse-btn");
    const previewWrap   = document.getElementById("file-preview-container");
    const previewImg    = document.getElementById("file-preview-img");
    const removeFileBtn = document.getElementById("remove-file-btn");
    const predictFileBtn= document.getElementById("predict-file-btn");
    const urlInput      = document.getElementById("url-input");
    const predictUrlBtn = document.getElementById("predict-url-btn");
    const inputSection  = document.querySelector(".input-section");
    const loadingState  = document.getElementById("loading-state");
    const errorState    = document.getElementById("error-state");
    const errorMessage  = document.getElementById("error-message");
    const resultsSection= document.getElementById("results-section");
    const resultImg     = document.getElementById("result-img");
    const bboxOverlay   = document.getElementById("bbox-overlay");
    const predictedBadge= document.getElementById("predicted-badge");
    const dryProb       = document.getElementById("dry-prob");
    const wetProb       = document.getElementById("wet-prob");
    const dryFill       = document.getElementById("dry-fill");
    const wetFill       = document.getElementById("wet-fill");
    const resetBtn      = document.getElementById("reset-btn");
    let currentFile = null;

    browseBtn.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", e => { e.preventDefault(); dropZone.classList.remove("dragover"); if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });
    fileInput.addEventListener("change", e => { if (e.target.files.length) handleFile(e.target.files[0]); });
    removeFileBtn.addEventListener("click", () => { currentFile = null; fileInput.value = ""; previewImg.src = ""; dropZone.classList.remove("hidden"); previewWrap.classList.add("hidden"); predictFileBtn.disabled = true; });
    urlInput.addEventListener("input", e => { predictUrlBtn.disabled = e.target.value.trim().length === 0; });
    resetBtn.addEventListener("click", () => { resultsSection.classList.add("hidden"); inputSection.classList.remove("hidden"); });

    function handleFile(file) {
        if (!file.type.startsWith("image/")) { showError("Please upload a valid image file."); return; }
        currentFile = file; previewImg.src = URL.createObjectURL(file);
        dropZone.classList.add("hidden"); previewWrap.classList.remove("hidden");
        predictFileBtn.disabled = false; errorState.classList.add("hidden");
    }

    predictFileBtn.addEventListener("click", async () => {
        if (!currentFile) return;
        const fd = new FormData(); fd.append("file", currentFile);
        await runPrediction(`${API_BASE}/predict`, { method: "POST", body: fd }, URL.createObjectURL(currentFile));
    });
    predictUrlBtn.addEventListener("click", async () => {
        const url = urlInput.value.trim(); if (!url) return;
        await runPrediction(`${API_BASE}/predict-url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }, url);
    });

    async function runPrediction(endpoint, opts, displayUrl) {
        inputSection.classList.add("hidden"); errorState.classList.add("hidden"); loadingState.classList.remove("hidden");
        try {
            const res = await fetch(endpoint, opts); const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Prediction failed.");
            renderResults(data, displayUrl);
        } catch (err) {
            showError(err.message === "Failed to fetch" ? "Cannot connect to Backend API." : err.message);
            inputSection.classList.remove("hidden");
        } finally { loadingState.classList.add("hidden"); }
    }

    function renderResults(data, displayUrl) {
        resultImg.src = displayUrl;
        drawBbox(data.bbox);
        predictedBadge.textContent = data.class === "wet" ? "WET WASTE" : "DRY WASTE";
        predictedBadge.className = `badge ${data.class}`;
        dryFill.style.width = "0%"; wetFill.style.width = "0%";
        dryProb.textContent = `${data.probabilities.dry}%`;
        wetProb.textContent = `${data.probabilities.wet}%`;
        setTimeout(() => { dryFill.style.width = `${data.probabilities.dry}%`; wetFill.style.width = `${data.probabilities.wet}%`; }, 50);
        resultsSection.classList.remove("hidden");
    }

    let lastBbox = null, bboxObserver = null;
    function drawBbox(bbox) {
        lastBbox = bbox;
        if (!bbox) { bboxOverlay.classList.add("hidden"); return; }
        if (!bboxObserver && "ResizeObserver" in window) {
            bboxObserver = new ResizeObserver(positionBbox);
            bboxObserver.observe(resultImg);
        }
        resultImg.onload = positionBbox;
        requestAnimationFrame(positionBbox);
    }
    function positionBbox() {
        if (!lastBbox) return;
        const iw = resultImg.naturalWidth, ih = resultImg.naturalHeight;
        const cw = resultImg.clientWidth, ch = resultImg.clientHeight;
        if (!iw || !ih || !cw || !ch) return;
        // object-fit: contain — painted image is letterboxed inside the element
        const scale = Math.min(cw / iw, ch / ih);
        const dw = iw * scale, dh = ih * scale;
        const ox = resultImg.offsetLeft + (cw - dw) / 2;
        const oy = resultImg.offsetTop + (ch - dh) / 2;
        bboxOverlay.style.left   = `${ox + lastBbox.x * dw}px`;
        bboxOverlay.style.top    = `${oy + lastBbox.y * dh}px`;
        bboxOverlay.style.width  = `${lastBbox.w * dw}px`;
        bboxOverlay.style.height = `${lastBbox.h * dh}px`;
        bboxOverlay.classList.remove("hidden");
    }
    window.addEventListener("resize", positionBbox);

    function showError(msg) { errorMessage.textContent = msg; errorState.classList.remove("hidden"); }

    // ═══════════════════════════════════════════════════════════
    // Camera Capture
    // ═══════════════════════════════════════════════════════════
    const cameraVideo      = document.getElementById("camera-video");
    const cameraCanvas     = document.getElementById("camera-canvas");
    const startCameraBtn   = document.getElementById("start-camera-btn");
    const captureBtn       = document.getElementById("capture-btn");
    const retakeBtn        = document.getElementById("retake-btn");
    const predictCameraBtn = document.getElementById("predict-camera-btn");
    const cameraConfirmRow = document.getElementById("camera-confirm-row");
    const cameraGuide      = document.getElementById("camera-guide");
    let cameraStream = null;

    async function startCamera() {
        console.log("[camera] Start Camera clicked");
        // Release any stream still held (e.g. from a previous start) — on
        // Windows many webcams allow only one active capture, so a leftover
        // stream makes the next getUserMedia fail with NotReadableError.
        if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
        try {
            // Plain `video: true` — a facingMode constraint is for phones and
            // can fail on a laptop that only has a front-facing webcam.
            cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
            console.log("[camera] stream acquired");
            cameraVideo.srcObject = cameraStream;
            await cameraVideo.play().catch(() => {});
            cameraVideo.classList.remove("hidden");
            cameraCanvas.classList.add("hidden");
            cameraGuide.classList.remove("hidden");
            startCameraBtn.classList.add("hidden");
            captureBtn.classList.remove("hidden");
            cameraConfirmRow.classList.add("hidden");
            errorState.classList.add("hidden");
        } catch (err) {
            console.error("[camera] getUserMedia failed:", err.name, err.message);
            showError(`Could not access camera (${err.name}): ${err.message}`);
            errorState.scrollIntoView({ behavior: "smooth", block: "center" });
        }
    }

    function stopCamera() {
        if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
        cameraVideo.srcObject = null;
        cameraVideo.classList.remove("hidden");
        cameraCanvas.classList.add("hidden");
        cameraGuide.classList.add("hidden");
        captureBtn.classList.add("hidden");
        cameraConfirmRow.classList.add("hidden");
        startCameraBtn.classList.remove("hidden");
    }

    startCameraBtn.addEventListener("click", startCamera);
    console.log("[camera] listeners attached (build 4 + bbox)");

    captureBtn.addEventListener("click", () => {
        cameraCanvas.width = cameraVideo.videoWidth;
        cameraCanvas.height = cameraVideo.videoHeight;
        cameraCanvas.getContext("2d").drawImage(cameraVideo, 0, 0);
        cameraVideo.classList.add("hidden");
        cameraCanvas.classList.remove("hidden");
        cameraGuide.classList.add("hidden");
        captureBtn.classList.add("hidden");
        cameraConfirmRow.classList.remove("hidden");
    });

    retakeBtn.addEventListener("click", () => {
        cameraCanvas.classList.add("hidden");
        cameraVideo.classList.remove("hidden");
        cameraGuide.classList.remove("hidden");
        cameraConfirmRow.classList.add("hidden");
        captureBtn.classList.remove("hidden");
    });

    predictCameraBtn.addEventListener("click", () => {
        cameraCanvas.toBlob(async (blob) => {
            const fd = new FormData(); fd.append("file", blob, "camera-capture.jpg");
            const snapshot = cameraCanvas.toDataURL("image/jpeg");
            stopCamera();
            await runPrediction(`${API_BASE}/predict`, { method: "POST", body: fd }, snapshot);
        }, "image/jpeg", 0.92);
    });

    // Release the webcam whenever the user navigates away from the Camera
    // tab, so the camera indicator light turns off and it isn't left in use.
    document.querySelectorAll(".tab").forEach(tab => {
        tab.addEventListener("click", () => {
            if (tab.dataset.target !== "camera-tab") stopCamera();
        });
    });

    // ═══════════════════════════════════════════════════════════
    // 2. Dataset Explorer
    // ═══════════════════════════════════════════════════════════
    let explorerLoaded = false;
    let foldersLoaded = false;
    const foldersView = document.getElementById("dataset-folders-view");
    const galleryView = document.getElementById("dataset-gallery-view");
    const folderGrid  = document.getElementById("folder-grid");
    const backBtn     = document.getElementById("back-to-folders");
    const gallTitle   = document.getElementById("gallery-title");
    const statTotal   = document.getElementById("stat-total");
    const statWet     = document.getElementById("stat-wet");
    const statDry     = document.getElementById("stat-dry");
    const thumbGrid   = document.getElementById("thumbnail-grid");
    const gallPrev    = document.getElementById("gallery-prev");
    const gallNext    = document.getElementById("gallery-next");
    const gallPageLbl = document.getElementById("gallery-page");
    const catFilter   = document.getElementById("category-filter");
    const imageModal  = document.getElementById("image-modal");
    const closeModal  = document.getElementById("close-modal");
    const modalImg    = document.getElementById("modal-img");
    const modalSplit  = document.getElementById("modal-split");
    const modalWetdry = document.getElementById("modal-wetdry");
    const modalDataset= document.getElementById("modal-dataset");
    const modalOriginal=document.getElementById("modal-original");
    const modalMapped = document.getElementById("modal-mapped");
    const modalSplitT = document.getElementById("modal-split-text");

    let curDataset = null, curFolderDef = null;
    let gallPage = 1, gallTotalPages = 1;
    let activeTargetFilter = null;
    let activeCatFilter = null;

    async function initExplorer() { explorerLoaded = true; if (!foldersLoaded) await loadFolders(); }

    async function loadFolders() {
        try {
            const res = await fetch(`${API_BASE}/api/dashboard/datasets_list`);
            const folders = await res.json();
            if (!folders.length) { folderGrid.innerHTML = `<p style="color:var(--text-secondary)">No datasets found. Run the download script first.</p>`; return; }
            folderGrid.innerHTML = "";
            folders.forEach(f => {
                const card = document.createElement("div"); card.className = "folder-card";
                const catTags = (f.categories || []).slice(0, 8).map(c => `<span class="category-tag">${c}</span>`).join("");
                const moreTag = (f.categories || []).length > 8 ? `<span class="category-tag">+${f.categories.length - 8} more</span>` : "";
                card.innerHTML = `
                    <div class="folder-header">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                        ${f.name}
                    </div>
                    <div class="folder-stats">
                        <span>Total: ${f.total.toLocaleString()}</span>
                        <span>Wet: <span class="wet-text">${f.wet.toLocaleString()}</span> · Dry: <span class="dry-text">${f.dry.toLocaleString()}</span></span>
                    </div>
                    <div class="folder-categories">${catTags}${moreTag}</div>`;
                card.addEventListener("click", () => openGallery(f));
                folderGrid.appendChild(card);
            });
            foldersLoaded = true;
        } catch (e) { console.error(e); folderGrid.innerHTML = `<p class="error-text">Failed to load datasets.</p>`; }
    }

    async function openGallery(f) {
        curDataset = f.name; curFolderDef = f; gallPage = 1;
        activeTargetFilter = null; activeCatFilter = null;
        gallTitle.textContent = curDataset;
        statTotal.textContent = f.total.toLocaleString();
        statWet.textContent = f.wet.toLocaleString();
        statDry.textContent = f.dry.toLocaleString();
        // Populate category dropdown
        catFilter.innerHTML = `<option value="">All Categories</option>`;
        (f.categories || []).forEach(c => { const o = document.createElement("option"); o.value = c; o.textContent = c; catFilter.appendChild(o); });
        // Reset filter toggles
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
        foldersView.classList.add("hidden"); galleryView.classList.remove("hidden");
        await fetchGalleryPage(gallPage);
    }

    async function fetchGalleryPage(page) {
        thumbGrid.innerHTML = '<div class="spinner"></div>';
        let url = `${API_BASE}/api/dashboard/images?dataset=${encodeURIComponent(curDataset)}&page=${page}&limit=24`;
        if (activeTargetFilter) url += `&target_class=${activeTargetFilter}`;
        if (activeCatFilter) url += `&original_class=${encodeURIComponent(activeCatFilter)}`;
        try {
            const res = await fetch(url); const data = await res.json();
            gallTotalPages = data.pages;
            gallPageLbl.textContent = `Page ${page} of ${gallTotalPages || 1}`;
            gallPrev.disabled = page <= 1; gallNext.disabled = page >= gallTotalPages;
            if (!data.items.length) { thumbGrid.innerHTML = '<p style="color:var(--text-secondary); text-align:center;">No images match the current filters.</p>'; return; }
            thumbGrid.innerHTML = "";
            data.items.forEach(item => {
                const w = document.createElement("div"); w.className = "thumbnail-wrapper";
                w.innerHTML = `
                    <img src="${API_BASE}/api/dashboard/serve_image?path=${encodeURIComponent(item.path)}" loading="lazy">
                    <div class="thumb-overlay">
                        <span class="thumb-category">${item.original_class}</span>
                        <span class="thumb-type ${item.target_class}">${item.target_class.charAt(0).toUpperCase()}</span>
                    </div>`;
                w.addEventListener("click", () => openImageModal(item));
                thumbGrid.appendChild(w);
            });
        } catch (e) { console.error(e); thumbGrid.innerHTML = '<p class="error-text">Failed to load images.</p>'; }
    }

    // Filter controls
    document.querySelectorAll(".filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            activeTargetFilter = btn.dataset.filter === "all" ? null : btn.dataset.filter;
            gallPage = 1; fetchGalleryPage(gallPage);
        });
    });
    catFilter.addEventListener("change", () => { activeCatFilter = catFilter.value || null; gallPage = 1; fetchGalleryPage(gallPage); });

    backBtn.addEventListener("click", () => { galleryView.classList.add("hidden"); foldersView.classList.remove("hidden"); });
    gallPrev.addEventListener("click", () => { if (gallPage > 1) { gallPage--; fetchGalleryPage(gallPage); } });
    gallNext.addEventListener("click", () => { if (gallPage < gallTotalPages) { gallPage++; fetchGalleryPage(gallPage); } });

    // Modal
    function openImageModal(item) {
        modalImg.src = `${API_BASE}/api/dashboard/serve_image?path=${encodeURIComponent(item.path)}`;
        modalSplit.textContent = item.split.toUpperCase(); modalSplit.className = `badge split-badge ${item.split}`;
        modalWetdry.textContent = item.target_class.toUpperCase(); modalWetdry.className = `badge ${item.target_class}`;
        modalDataset.textContent = item.dataset;
        modalOriginal.textContent = item.original_class;
        modalMapped.textContent = item.target_class.toUpperCase();
        modalMapped.style.color = item.target_class === "wet" ? "var(--wet-color)" : "var(--dry-color)";
        modalSplitT.textContent = item.split.toUpperCase();
        imageModal.classList.remove("hidden");
    }
    closeModal.addEventListener("click", () => imageModal.classList.add("hidden"));
    imageModal.addEventListener("click", e => { if (e.target === imageModal) imageModal.classList.add("hidden"); });

    // ═══════════════════════════════════════════════════════════
    // 3. Model Insights
    // ═══════════════════════════════════════════════════════════
    let insightsLoaded = false;
    const insightsContent = document.getElementById("insights-content");

    async function initInsights() {
        insightsLoaded = true;
        try {
            const res = await fetch(`${API_BASE}/api/dashboard/model_info`);
            const data = await res.json();
            let html = "";

            // ── Hero Accuracy ──
            if (data.evaluation && data.evaluation.accuracy != null) {
                const acc = (data.evaluation.accuracy * 100).toFixed(2);
                const auc = data.evaluation.roc_auc ? (data.evaluation.roc_auc * 100).toFixed(2) : null;
                html += `<div class="insight-card accuracy-display">
                    <div class="accuracy-score">${acc}%</div>
                    <div class="accuracy-label">Overall Test Accuracy</div>
                </div>`;

                // ── Key Metrics Row ──
                html += `<div class="metrics-row">
                    ${auc ? `<div class="metric-card">
                        <div class="metric-value">${auc}%</div>
                        <div class="metric-name">ROC-AUC</div>
                        <div class="metric-tooltip">Area Under the ROC Curve. Measures how well the model separates wet from dry across all confidence thresholds. 100% = perfect, 50% = random guessing.</div>
                    </div>` : ""}
                    ${buildMetricFromReport(data.classification_report, "precision")}
                    ${buildMetricFromReport(data.classification_report, "recall")}
                    ${buildMetricFromReport(data.classification_report, "f1-score")}
                </div>`;

                // ── Confusion Matrix ──
                html += buildConfusionMatrix(data.classification_report);

            } else {
                html += `<div class="insight-card accuracy-display">
                    <div class="accuracy-score" style="-webkit-text-fill-color: var(--text-secondary);">--</div>
                    <div class="accuracy-label">Model Evaluation Pending</div>
                </div>`;
            }

            // ── Training History Plot ──
            if (data.plots && data.plots.includes("training_history.png")) {
                html += `<div class="insight-card">
                    <h3>Training History</h3>
                    <div class="plot-gallery">
                        <img src="${API_BASE}/api/dashboard/serve_plot?filename=training_history.png" alt="Training History">
                    </div>
                </div>`;
            }

            // ── Architecture ──
            html += `<div class="insight-card">
                <h3>Architecture</h3>
                <div class="insight-grid">
                    <div><span class="detail-label">Backbone</span><div class="insight-val">${data.model.backbone}</div></div>
                    <div><span class="detail-label">Input Shape</span><div class="insight-val">${data.model.input_shape.join(" × ")}</div></div>
                    <div><span class="detail-label">Dense Units</span><div class="insight-val">${data.model.dense_units}</div></div>
                    <div><span class="detail-label">Dropout</span><div class="insight-val">${data.model.dropout_rate}</div></div>
                </div>
            </div>`;

            // ── Training Config ──
            html += `<div class="insight-card">
                <h3>Training Hyperparameters</h3>
                <div class="insight-grid">
                    <div><span class="detail-label">Batch Size</span><div class="insight-val">${data.training.batch_size}</div></div>
                    <div><span class="detail-label">Phase 1 Epochs</span><div class="insight-val">${data.training.phase1_epochs}</div></div>
                    <div><span class="detail-label">Phase 2 Epochs</span><div class="insight-val">${data.training.phase2_epochs}</div></div>
                    <div><span class="detail-label">Early Stop Patience</span><div class="insight-val">${data.training.early_stopping_patience}</div></div>
                </div>
            </div>`;

            insightsContent.innerHTML = html;
        } catch (e) { console.error(e); insightsContent.innerHTML = '<div class="error-container"><p>Failed to load insights.</p></div>'; }
    }

    // ── Helpers ──

    function buildMetricFromReport(report, metric) {
        if (!report) return "";
        // Parse weighted avg line
        const lines = report.split("\n");
        const wavgLine = lines.find(l => l.includes("weighted avg"));
        if (!wavgLine) return "";
        const parts = wavgLine.trim().split(/\s+/);
        // weighted avg   precision   recall   f1   support
        let val = "", tooltip = "";
        if (metric === "precision") { val = parts[2]; tooltip = "Of all images the model predicted as a class, how many were actually that class. High precision = few false alarms."; }
        else if (metric === "recall") { val = parts[3]; tooltip = "Of all images that actually belong to a class, how many did the model find. High recall = few missed items."; }
        else if (metric === "f1-score") { val = parts[4]; tooltip = "Harmonic mean of precision and recall. Balances both metrics into a single score. 1.0 = perfect."; }
        if (!val) return "";
        return `<div class="metric-card">
            <div class="metric-value">${(parseFloat(val) * 100).toFixed(1)}%</div>
            <div class="metric-name">${metric.replace("-", " ")}</div>
            <div class="metric-tooltip">${tooltip}</div>
        </div>`;
    }

    function buildConfusionMatrix(report) {
        if (!report) return "";
        const lines = report.split("\n");
        // Find dry and wet lines
        const dryLine = lines.find(l => l.trim().startsWith("dry"));
        const wetLine = lines.find(l => l.trim().startsWith("wet"));
        if (!dryLine || !wetLine) return "";

        const dryParts = dryLine.trim().split(/\s+/);
        const wetParts = wetLine.trim().split(/\s+/);
        // dry: precision recall f1 support
        // wet: precision recall f1 support
        const drySupport = parseInt(dryParts[4]);
        const wetSupport = parseInt(wetParts[4]);
        const dryRecall = parseFloat(dryParts[2]);
        const wetRecall = parseFloat(wetParts[2]);
        const dryPrec = parseFloat(dryParts[1]);

        // Reconstruct confusion matrix from precision/recall/support
        const TP_dry = Math.round(dryRecall * drySupport); // correctly classified dry 
        const FN_dry = drySupport - TP_dry;                  // dry classified as wet
        const TP_wet = Math.round(wetRecall * wetSupport);
        const FN_wet = wetSupport - TP_wet;                   // wet classified as dry

        return `<div class="insight-card">
            <h3>Confusion Matrix</h3>
            <table class="cm-table">
                <tr><th></th><th>Predicted DRY</th><th>Predicted WET</th><th>Total</th></tr>
                <tr>
                    <th>Actual DRY</th>
                    <td class="cm-correct">${TP_dry.toLocaleString()}</td>
                    <td class="cm-wrong">${FN_dry.toLocaleString()}</td>
                    <td>${drySupport.toLocaleString()}</td>
                </tr>
                <tr>
                    <th>Actual WET</th>
                    <td class="cm-wrong">${FN_wet.toLocaleString()}</td>
                    <td class="cm-correct">${TP_wet.toLocaleString()}</td>
                    <td>${wetSupport.toLocaleString()}</td>
                </tr>
            </table>
            <div class="cm-explainer">
                <strong>How to read this:</strong> The green cells show correct predictions. The red cells show mistakes.
                For example, ${FN_dry} dry items were incorrectly classified as wet, and ${FN_wet} wet items were incorrectly classified as dry.
                Hover over the metric cards above for detailed explanations of precision, recall, and F1 score.
            </div>
        </div>`;
    }
});
