(function () {
    const endpoints = {
        save: "/forge-prompt-sets/save",
        item: "/forge-prompt-sets/item",
        card: "/forge-prompt-sets/card",
        delete: "/forge-prompt-sets/delete",
        folders: "/forge-prompt-sets/folders",
    };
    const injectedPromptSets = {};
    const initialRefreshDone = new Set();

    function app() {
        return typeof gradioApp === "function" ? gradioApp() : document;
    }

    function prevent(event) {
        if (!event) return;
        event.preventDefault();
        event.stopPropagation();
    }

    function safeId(value) {
        return String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_");
    }

    function ensureDialog(tabname) {
        let dialog = document.getElementById(`forge_prompt_sets_dialog_${safeId(tabname)}`);
        if (dialog) return dialog;

        dialog = document.createElement("div");
        dialog.id = `forge_prompt_sets_dialog_${safeId(tabname)}`;
        dialog.className = "forge-prompt-sets-dialog";
        dialog.innerHTML = `
            <div class="forge-prompt-sets-dialog-panel">
                <div class="forge-prompt-sets-dialog-head">
                    <div>
                        <div class="forge-prompt-sets-dialog-title">Prompt Set</div>
                        <div class="forge-prompt-sets-dialog-subtitle">Save reusable prompt text as an Extra Networks card.</div>
                    </div>
                    <button class="forge-prompt-sets-x forge-prompt-sets-close" type="button" title="Close" aria-label="Close">X</button>
                </div>

                <input class="forge-prompt-sets-original-id" type="hidden">

                <div class="forge-prompt-sets-layout">
                    <label class="forge-prompt-sets-preview-box">
                        <input class="forge-prompt-sets-preview" type="file" accept="image/*">
                        <img class="forge-prompt-sets-preview-img" alt="" hidden>
                        <span class="forge-prompt-sets-preview-placeholder">
                            <strong>Preview image</strong>
                            <small>Click to choose a card image</small>
                        </span>
                    </label>

                    <div class="forge-prompt-sets-fields">
                        <div class="forge-prompt-sets-row two">
                            <label>
                                <span>Name</span>
                                <input class="forge-prompt-sets-name" placeholder="Prompt set name">
                            </label>
                            <label class="forge-prompt-sets-folder-label">
                                <span>Folder / category</span>
                                <div class="forge-prompt-sets-combobox">
                                    <input class="forge-prompt-sets-folder" autocomplete="off" placeholder="01 / portraits">
                                    <div class="forge-prompt-sets-suggestions" role="listbox" hidden></div>
                                </div>
                            </label>
                        </div>

                        <label>
                            <span>Prompt</span>
                            <textarea class="forge-prompt-sets-prompt" placeholder="Prompt text"></textarea>
                        </label>

                        <label>
                            <span>Negative prompt</span>
                            <textarea class="forge-prompt-sets-negative" placeholder="Optional negative prompt"></textarea>
                        </label>

                        <div class="forge-prompt-sets-row two">
                            <label>
                                <span>Search keywords</span>
                                <input class="forge-prompt-sets-tags" placeholder="optional, comma separated">
                            </label>
                            <div class="forge-prompt-sets-inline-actions">
                                <button class="forge-prompt-sets-btn secondary forge-prompt-sets-capture" type="button">Use current prompt</button>
                            </div>
                        </div>

                        <label>
                            <span>Description</span>
                            <textarea class="forge-prompt-sets-description" placeholder="Optional note shown on the card"></textarea>
                        </label>

                        <div class="forge-prompt-sets-actions">
                            <button class="forge-prompt-sets-btn secondary forge-prompt-sets-clear" type="button">Clear</button>
                            <button class="forge-prompt-sets-btn danger forge-prompt-sets-delete-current" type="button" hidden>Delete</button>
                            <span class="forge-prompt-sets-status"></span>
                            <button class="forge-prompt-sets-btn secondary forge-prompt-sets-cancel" type="button">Cancel</button>
                            <button class="forge-prompt-sets-btn primary forge-prompt-sets-save" type="button">Save</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        dialog.querySelector(".forge-prompt-sets-close").addEventListener("click", (event) => {
            prevent(event);
            closeDialog(tabname);
        });
        dialog.addEventListener("click", (event) => {
            if (event.target === dialog) closeDialog(tabname);
        });
        dialog.querySelector(".forge-prompt-sets-capture").addEventListener("click", (event) => window.forgePromptSetsCapture(event, tabname));
        dialog.querySelector(".forge-prompt-sets-save").addEventListener("click", (event) => window.forgePromptSetsSave(event, tabname));
        dialog.querySelector(".forge-prompt-sets-clear").addEventListener("click", (event) => window.forgePromptSetsClear(event, tabname, true));
        dialog.querySelector(".forge-prompt-sets-delete-current").addEventListener("click", (event) => window.forgePromptSetsDeleteCurrent(event, tabname));
        dialog.querySelector(".forge-prompt-sets-cancel").addEventListener("click", (event) => {
            prevent(event);
            closeDialog(tabname);
        });
        dialog.querySelector(".forge-prompt-sets-preview").addEventListener("change", () => updatePreviewFromFile(tabname));
        wirePreviewDrop(dialog, tabname);
        dialog.querySelectorAll(".forge-prompt-sets-fields textarea").forEach((textarea) => {
            textarea.addEventListener("input", () => autoGrowTextarea(textarea));
        });
        wireFolderSuggestions(dialog, tabname);

        document.body.appendChild(dialog);
        return dialog;
    }

    function root(tabname) {
        return ensureDialog(tabname);
    }

    function field(tabname, selector) {
        const container = root(tabname);
        return container ? container.querySelector(selector) : null;
    }

    function setStatus(tabname, text, isError) {
        const status = field(tabname, ".forge-prompt-sets-status");
        if (!status) return;
        status.textContent = text || "";
        status.classList.toggle("error", Boolean(isError));
    }

    function updateDeleteButton(tabname) {
        const button = field(tabname, ".forge-prompt-sets-delete-current");
        const originalId = field(tabname, ".forge-prompt-sets-original-id");
        if (!button) return;

        const canDelete = Boolean(originalId && originalId.value);
        button.hidden = !canDelete;
        button.disabled = !canDelete;
    }

    function autoGrowTextarea(textarea) {
        if (!textarea) return;

        const style = window.getComputedStyle(textarea);
        const maxHeight = Number.parseFloat(style.maxHeight) || 250;
        textarea.style.height = "auto";

        const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
        textarea.style.height = `${nextHeight}px`;
        textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
    }

    function refreshTextareas(tabname) {
        const dialog = root(tabname);
        window.requestAnimationFrame(() => {
            dialog.querySelectorAll(".forge-prompt-sets-fields textarea").forEach(autoGrowTextarea);
        });
    }

    function closeDialog(tabname) {
        const dialog = root(tabname);
        hideFolderSuggestions(tabname);
        dialog.classList.remove("open");
    }

    function currentTextarea(tabname, elemId) {
        return app().querySelector(`#${tabname}_${elemId} textarea`);
    }

    function positiveTextarea(tabname) {
        return currentTextarea(tabname, "prompt");
    }

    function negativeTextarea(tabname) {
        return currentTextarea(tabname, "neg_prompt");
    }

    function promptSetState(tabname) {
        if (!injectedPromptSets[tabname]) injectedPromptSets[tabname] = {};
        return injectedPromptSets[tabname];
    }

    function promptSeparator() {
        if (window.opts && typeof window.opts.extra_networks_add_text_separator === "string") {
            return window.opts.extra_networks_add_text_separator;
        }
        return ", ";
    }

    function promptSeparatorForValue(value) {
        const separator = promptSeparator();
        const currentValue = value || "";
        if (!currentValue.trim()) return "";

        if (separator.trimStart().startsWith(",") && /,\s*$/.test(currentValue)) {
            const afterComma = separator.replace(/^\s*,/, "");
            return /\s$/.test(currentValue) ? afterComma.replace(/^\s+/, "") : afterComma;
        }

        return separator;
    }

    function notifyTextareaChanged(textarea) {
        if (!textarea) return;

        if (typeof window.updateInput === "function") {
            window.updateInput(textarea);
        } else {
            textarea.dispatchEvent(new Event("input", {bubbles: true}));
            textarea.dispatchEvent(new Event("change", {bubbles: true}));
        }
    }

    function addPromptSetText(textarea, text) {
        if (!textarea || !text) return null;

        const separator = promptSeparatorForValue(textarea.value);
        const segment = `${separator}${text}`;
        textarea.value += segment;
        notifyTextareaChanged(textarea);
        return segment;
    }

    function removeExactSegment(value, segment) {
        if (!segment) return null;

        const index = value.lastIndexOf(segment);
        if (index < 0) return null;

        return value.slice(0, index) + value.slice(index + segment.length);
    }

    function removePromptSetText(textarea, record) {
        if (!textarea || !record || !record.text) return false;

        const candidates = [record.segment, record.text].filter(Boolean);
        for (const candidate of candidates) {
            const nextValue = removeExactSegment(textarea.value, candidate);
            if (nextValue === null) continue;

            textarea.value = nextValue;
            notifyTextareaChanged(textarea);
            return true;
        }

        return false;
    }

    function setCardActive(tabname, promptSetId, active) {
        app().querySelectorAll(".forge-prompt-set-card").forEach((card) => {
            if (card.dataset.promptSetId === promptSetId) {
                card.classList.toggle("forge-prompt-set-card-active", active);
            }
        });
    }

    function promptSetsCardsContainer(tabname) {
        return app().querySelector(`#${tabname}_prompt_sets_cards`);
    }

    function findPromptSetCard(tabname, promptSetId) {
        const container = promptSetsCardsContainer(tabname);
        if (!container) return null;

        return Array.from(container.querySelectorAll(".forge-prompt-set-card"))
            .find((card) => card.dataset.promptSetId === promptSetId) || null;
    }

    function applyPromptSetsFilter(tabname) {
        if (typeof window.applyExtraNetworkFilter === "function") {
            window.applyExtraNetworkFilter(`${tabname}_prompt_sets`);
        }
    }

    async function fetchPromptSetCardHtml(tabname, promptSetId) {
        const qs = new URLSearchParams({
            tabname,
            id: promptSetId,
        });
        const response = await fetch(`${endpoints.card}?${qs}`);
        const data = await response.json();
        if (!response.ok || !data.html) throw new Error(data.error || response.statusText || "Card refresh failed");
        return data.html;
    }

    async function upsertPromptSetCard(tabname, promptSetId, previousId, cardHtml) {
        try {
            const container = promptSetsCardsContainer(tabname);
            if (!container) throw new Error("Prompt Sets card container not found");

            const html = cardHtml || await fetchPromptSetCardHtml(tabname, promptSetId);
            const wrapper = document.createElement("div");
            wrapper.innerHTML = html.trim();
            const newCard = wrapper.firstElementChild;
            if (!newCard) throw new Error("Prompt Set card HTML was empty");

            const oldCard = (previousId && findPromptSetCard(tabname, previousId)) || findPromptSetCard(tabname, promptSetId);
            if (oldCard) {
                oldCard.replaceWith(newCard);
            } else {
                const addCard = container.querySelector(".forge-prompt-sets-add-card");
                if (addCard && addCard.nextSibling) {
                    container.insertBefore(newCard, addCard.nextSibling);
                } else if (addCard) {
                    container.appendChild(newCard);
                } else {
                    container.appendChild(newCard);
                }
            }

            applyPromptSetsFilter(tabname);
            setCardActive(tabname, promptSetId, Boolean(promptSetState(tabname)[promptSetId]));
            return true;
        } catch (error) {
            console.warn("[ForgePromptSets] Fast card refresh failed; falling back to full refresh", error);
            clickRefresh(tabname);
            return false;
        }
    }

    function removePromptSetCard(tabname, promptSetId) {
        const card = findPromptSetCard(tabname, promptSetId);
        if (!card) {
            clickRefresh(tabname);
            return false;
        }

        card.remove();
        applyPromptSetsFilter(tabname);
        return true;
    }

    function clickRefresh(tabname) {
        const button = app().querySelector(`#${tabname}_prompt_sets_extra_refresh_internal`);
        if (button) button.click();
    }

    function tabnameFromRefreshButton(button) {
        const match = button && button.id ? button.id.match(/^(.+)_prompt_sets_extra_refresh_internal$/) : null;
        return match ? match[1] : "";
    }

    function refreshPromptSetsAfterInitialRender() {
        app().querySelectorAll("[id$='_prompt_sets_extra_refresh_internal']").forEach((button) => {
            const tabname = tabnameFromRefreshButton(button);
            if (!tabname || initialRefreshDone.has(tabname)) return;
            initialRefreshDone.add(tabname);

            setTimeout(() => {
                const currentButton = app().querySelector(`#${tabname}_prompt_sets_extra_refresh_internal`);
                if (currentButton) currentButton.click();
            }, 350);
        });
    }

    function registerInitialPromptSetsRefresh() {
        if (typeof window.onAfterUiUpdate === "function") {
            window.onAfterUiUpdate(refreshPromptSetsAfterInitialRender);
        } else if (typeof onAfterUiUpdate === "function") {
            onAfterUiUpdate(refreshPromptSetsAfterInitialRender);
        }

        if (typeof window.onUiLoaded === "function") {
            window.onUiLoaded(() => setTimeout(refreshPromptSetsAfterInitialRender, 500));
        } else if (typeof onUiLoaded === "function") {
            onUiLoaded(() => setTimeout(refreshPromptSetsAfterInitialRender, 500));
        } else {
            setTimeout(refreshPromptSetsAfterInitialRender, 700);
        }
    }

    async function populateFolders(tabname) {
        try {
            const response = await fetch(endpoints.folders);
            const data = await response.json();
            if (!response.ok || !data.ok) return;

            root(tabname).__forgePromptSetFolders = data.folders || [];
            renderFolderSuggestions(tabname);
        } catch (error) {
            console.debug("[ForgePromptSets] folder suggestions unavailable", error);
        }
    }

    function wireFolderSuggestions(dialog, tabname) {
        const input = dialog.querySelector(".forge-prompt-sets-folder");
        const menu = dialog.querySelector(".forge-prompt-sets-suggestions");
        if (!input || !menu) return;

        input.addEventListener("focus", () => renderFolderSuggestions(tabname));
        input.addEventListener("input", () => renderFolderSuggestions(tabname));
        input.addEventListener("blur", () => {
            setTimeout(() => hideFolderSuggestions(tabname), 120);
        });
        input.addEventListener("keydown", (event) => handleFolderSuggestionKeys(event, tabname));

        menu.addEventListener("mousedown", (event) => {
            const option = event.target.closest(".forge-prompt-sets-suggestion");
            if (!option) return;
            prevent(event);
            chooseFolderSuggestion(tabname, option.dataset.value || "");
        });
    }

    function folderSuggestions(tabname) {
        return field(tabname, ".forge-prompt-sets-suggestions");
    }

    function hideFolderSuggestions(tabname) {
        const menu = folderSuggestions(tabname);
        if (menu) menu.hidden = true;
    }

    function renderFolderSuggestions(tabname) {
        const input = field(tabname, ".forge-prompt-sets-folder");
        const menu = folderSuggestions(tabname);
        if (!input || !menu) return;
        if (document.activeElement !== input) {
            menu.hidden = true;
            return;
        }

        const folders = root(tabname).__forgePromptSetFolders || [];
        const query = input.value.trim().toLowerCase();
        const matches = folders
            .filter((folder) => !query || folder.toLowerCase().includes(query))
            .slice(0, 12);

        menu.innerHTML = "";
        if (!matches.length) {
            menu.hidden = true;
            return;
        }

        for (const folder of matches) {
            const option = document.createElement("button");
            option.type = "button";
            option.className = "forge-prompt-sets-suggestion";
            option.dataset.value = folder;
            option.setAttribute("role", "option");
            option.innerHTML = `
                <span class="forge-prompt-sets-suggestion-mark"></span>
                <span class="forge-prompt-sets-suggestion-text"></span>
            `;
            option.querySelector(".forge-prompt-sets-suggestion-text").textContent = folder;
            menu.appendChild(option);
        }

        menu.firstElementChild.classList.add("active");
        menu.hidden = false;
    }

    function moveFolderSuggestion(tabname, delta) {
        const menu = folderSuggestions(tabname);
        if (!menu || menu.hidden) return;
        const options = Array.from(menu.querySelectorAll(".forge-prompt-sets-suggestion"));
        if (!options.length) return;

        let index = options.findIndex((option) => option.classList.contains("active"));
        index = (index + delta + options.length) % options.length;
        options.forEach((option) => option.classList.remove("active"));
        options[index].classList.add("active");
        options[index].scrollIntoView({block: "nearest"});
    }

    function chooseFolderSuggestion(tabname, value) {
        const input = field(tabname, ".forge-prompt-sets-folder");
        if (input) {
            input.value = value;
            input.focus();
        }
        hideFolderSuggestions(tabname);
    }

    function handleFolderSuggestionKeys(event, tabname) {
        const menu = folderSuggestions(tabname);

        if (event.key === "Escape") {
            hideFolderSuggestions(tabname);
            return;
        }

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            prevent(event);
            if (!menu || menu.hidden) {
                renderFolderSuggestions(tabname);
            } else {
                moveFolderSuggestion(tabname, event.key === "ArrowDown" ? 1 : -1);
            }
            return;
        }

        if (event.key === "Enter" && menu && !menu.hidden) {
            const active = menu.querySelector(".forge-prompt-sets-suggestion.active");
            if (active) {
                prevent(event);
                chooseFolderSuggestion(tabname, active.dataset.value || "");
            }
        }
    }

    function setPreview(tabname, src) {
        const image = field(tabname, ".forge-prompt-sets-preview-img");
        const placeholder = field(tabname, ".forge-prompt-sets-preview-placeholder");
        if (!image || !placeholder) return;

        if (src) {
            image.src = src;
            image.hidden = false;
            placeholder.hidden = true;
        } else {
            image.removeAttribute("src");
            image.hidden = true;
            placeholder.hidden = false;
        }
    }

    function isImageFile(file) {
        if (!file) return false;
        if (file.type && file.type.startsWith("image/")) return true;
        return /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name || "");
    }

    function previewInput(tabname) {
        return field(tabname, ".forge-prompt-sets-preview");
    }

    function clearPreviewSelection(tabname) {
        const input = previewInput(tabname);
        if (!input) return;
        input.value = "";
        input.__forgePromptSetsDroppedFile = null;
        input.__forgePromptSetsDroppedDataUrl = "";
    }

    function setPreviewFile(tabname, file) {
        const input = previewInput(tabname);
        if (!input) return;
        input.__forgePromptSetsDroppedFile = file || null;
        input.__forgePromptSetsDroppedDataUrl = "";
    }

    function setPreviewDataUrl(tabname, dataUrl) {
        const input = previewInput(tabname);
        if (!input) return;
        input.value = "";
        input.__forgePromptSetsDroppedFile = null;
        input.__forgePromptSetsDroppedDataUrl = dataUrl || "";
        setPreview(tabname, dataUrl || "");
    }

    function previewFileForSave(tabname) {
        const input = field(tabname, ".forge-prompt-sets-preview");
        return (input && input.files && input.files[0]) || (input && input.__forgePromptSetsDroppedFile) || null;
    }

    function previewDataUrlForSave(tabname) {
        const input = previewInput(tabname);
        return (input && input.__forgePromptSetsDroppedDataUrl) || "";
    }

    function updatePreviewFromFile(tabname) {
        const input = previewInput(tabname);
        const file = input && input.files ? input.files[0] : null;
        if (!file) {
            clearPreviewSelection(tabname);
            setPreview(tabname, "");
            return;
        }
        if (!isImageFile(file)) {
            clearPreviewSelection(tabname);
            setPreview(tabname, "");
            setStatus(tabname, "Choose an image file.", true);
            return;
        }

        setPreviewFile(tabname, file);
        const reader = new FileReader();
        reader.onload = () => setPreview(tabname, reader.result || "");
        reader.readAsDataURL(file);
    }

    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            if (!file) {
                resolve("");
                return;
            }

            const reader = new FileReader();
            reader.onload = () => resolve(reader.result || "");
            reader.onerror = () => reject(reader.error || new Error("Failed to read image"));
            reader.readAsDataURL(file);
        });
    }

    function droppedImageFile(event) {
        const files = event.dataTransfer && event.dataTransfer.files;
        if (!files || !files.length) return null;
        return Array.from(files).find(isImageFile) || files[0] || null;
    }

    function extractDroppedImageUrl(event) {
        const data = event.dataTransfer;
        if (!data) return "";

        const uriList = data.getData("text/uri-list");
        if (uriList) {
            const url = uriList.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
            if (url) return url.trim();
        }

        const html = data.getData("text/html");
        if (html) {
            try {
                const doc = new DOMParser().parseFromString(html, "text/html");
                const img = doc.querySelector("img[src]");
                if (img) return (img.src || img.getAttribute("src") || "").trim();
            } catch (error) {
                console.debug("[ForgePromptSets] Could not parse dropped HTML", error);
            }
        }

        const text = data.getData("text/plain");
        if (/^(data:image\/|https?:\/\/|\.?\/)/i.test(text || "")) return text.trim();
        return "";
    }

    async function dataUrlFromImageUrl(url) {
        if (!url) return "";
        if (url.startsWith("data:image/")) return url;

        const response = await fetch(url);
        if (!response.ok) throw new Error("Could not read dropped image URL.");
        const blob = await response.blob();
        if (!isImageFile(blob)) throw new Error("Drop an image file or direct image URL.");
        return await readFileAsDataUrl(blob);
    }

    function wirePreviewDrop(dialog, tabname) {
        const box = dialog.querySelector(".forge-prompt-sets-preview-box");
        if (!box || box.dataset.dropReady === "true") return;
        box.dataset.dropReady = "true";

        const clearDragState = () => box.classList.remove("drag-over");

        box.addEventListener("dragenter", (event) => {
            prevent(event);
            box.classList.add("drag-over");
        });
        box.addEventListener("dragover", (event) => {
            prevent(event);
            box.classList.add("drag-over");
        });
        box.addEventListener("dragleave", (event) => {
            if (!box.contains(event.relatedTarget)) clearDragState();
        });
        box.addEventListener("drop", async (event) => {
            prevent(event);
            clearDragState();

            const file = droppedImageFile(event);
            if (file) {
                if (!isImageFile(file)) {
                    setStatus(tabname, "Drop an image file.", true);
                    return;
                }
                setPreviewFile(tabname, file);
                setPreview(tabname, await readFileAsDataUrl(file));
                setStatus(tabname, "");
                return;
            }

            const url = extractDroppedImageUrl(event);
            if (!url) {
                setStatus(tabname, "Drop an image file or direct image URL.", true);
                return;
            }

            try {
                const dataUrl = await dataUrlFromImageUrl(url);
                setPreviewDataUrl(tabname, dataUrl);
                setStatus(tabname, "");
            } catch (error) {
                setStatus(tabname, error.message || "Image drop failed.", true);
            }
        });
    }

    function fillDialog(tabname, data) {
        field(tabname, ".forge-prompt-sets-original-id").value = data.id || "";
        field(tabname, ".forge-prompt-sets-name").value = data.name || "";
        field(tabname, ".forge-prompt-sets-folder").value = data.folder || "";
        field(tabname, ".forge-prompt-sets-prompt").value = data.prompt || "";
        field(tabname, ".forge-prompt-sets-negative").value = data.negative_prompt || "";
        field(tabname, ".forge-prompt-sets-tags").value = Array.isArray(data.tags) ? data.tags.join(", ") : (data.tags || "");
        field(tabname, ".forge-prompt-sets-description").value = data.description || "";
        clearPreviewSelection(tabname);
        setPreview(tabname, data.preview_url || "");
        hideFolderSuggestions(tabname);
        refreshTextareas(tabname);
        updateDeleteButton(tabname);
    }

    window.forgePromptSetsOpen = async function (event, tabname) {
        prevent(event);
        const dialog = ensureDialog(tabname);
        dialog.classList.add("open");
        window.forgePromptSetsClear(null, tabname, false);
        await populateFolders(tabname);
    };

    window.forgePromptSetsCapture = function (event, tabname) {
        prevent(event);

        const prompt = currentTextarea(tabname, "prompt");
        const negative = currentTextarea(tabname, "neg_prompt");
        const promptField = field(tabname, ".forge-prompt-sets-prompt");
        const negativeField = field(tabname, ".forge-prompt-sets-negative");
        const nameField = field(tabname, ".forge-prompt-sets-name");

        if (promptField && prompt) promptField.value = prompt.value || "";
        if (negativeField && negative) negativeField.value = negative.value || "";
        if (nameField && !nameField.value && prompt && prompt.value) {
            nameField.value = prompt.value.split(/\r?\n/)[0].slice(0, 48);
        }
        refreshTextareas(tabname);
        setStatus(tabname, "");
    };

    window.forgePromptSetsEdit = async function (event, tabname, promptSetId) {
        prevent(event);
        const dialog = ensureDialog(tabname);
        dialog.classList.add("open");
        setStatus(tabname, "Loading...");
        await populateFolders(tabname);

        try {
            const qs = new URLSearchParams({id: promptSetId}).toString();
            const response = await fetch(`${endpoints.item}?${qs}`);
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
            fillDialog(tabname, data.item);
            setStatus(tabname, "");
        } catch (error) {
            console.error("[ForgePromptSets] Edit failed", error);
            setStatus(tabname, error.message || "Load failed.", true);
        }
    };

    window.forgePromptSetsClear = function (event, tabname, keepOriginalId) {
        prevent(event);

        const originalId = field(tabname, ".forge-prompt-sets-original-id");
        const preservedOriginalId = keepOriginalId && originalId ? originalId.value : "";
        const selectors = [
            ".forge-prompt-sets-original-id",
            ".forge-prompt-sets-name",
            ".forge-prompt-sets-folder",
            ".forge-prompt-sets-prompt",
            ".forge-prompt-sets-negative",
            ".forge-prompt-sets-tags",
            ".forge-prompt-sets-description",
            ".forge-prompt-sets-preview",
        ];

        for (const selector of selectors) {
            const elem = field(tabname, selector);
            if (elem) elem.value = "";
        }
        if (keepOriginalId && originalId) originalId.value = preservedOriginalId;
        clearPreviewSelection(tabname);
        setPreview(tabname, "");
        setStatus(tabname, "");
        hideFolderSuggestions(tabname);
        refreshTextareas(tabname);
        updateDeleteButton(tabname);
    };

    window.forgePromptSetsSave = async function (event, tabname) {
        prevent(event);

        const originalId = field(tabname, ".forge-prompt-sets-original-id");
        const previousId = originalId ? originalId.value : "";
        const name = field(tabname, ".forge-prompt-sets-name");
        const folder = field(tabname, ".forge-prompt-sets-folder");
        const prompt = field(tabname, ".forge-prompt-sets-prompt");
        const negative = field(tabname, ".forge-prompt-sets-negative");
        const tags = field(tabname, ".forge-prompt-sets-tags");
        const description = field(tabname, ".forge-prompt-sets-description");
        const preview = field(tabname, ".forge-prompt-sets-preview");

        const isEditing = Boolean(originalId && originalId.value);
        if (!isEditing && (!prompt || !prompt.value.trim())) {
            setStatus(tabname, "Prompt is empty.", true);
            return;
        }

        setStatus(tabname, "Saving...");

        try {
            const previewFile = previewFileForSave(tabname);
            const previewDataUrl = previewFile
                ? await readFileAsDataUrl(previewFile)
                : previewDataUrlForSave(tabname);

            const response = await fetch(endpoints.save, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({
                    original_id: previousId,
                    tabname,
                    name: name ? name.value : "",
                    folder: folder ? folder.value : "",
                    prompt: prompt.value,
                    negative_prompt: negative ? negative.value : "",
                    tags: tags ? tags.value : "",
                    description: description ? description.value : "",
                    preview_data_url: previewDataUrl,
                }),
            });

            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);
            if (!data.item || !data.item.id) throw new Error("Save completed but no prompt set id was returned");

            setStatus(tabname, "Saved.");
            if (previousId && previousId !== data.item.id) {
                const state = promptSetState(tabname);
                delete state[previousId];
                setCardActive(tabname, previousId, false);
            }
            if (data.item && data.item.folder) {
                const folders = root(tabname).__forgePromptSetFolders || [];
                if (!folders.includes(data.item.folder)) {
                    root(tabname).__forgePromptSetFolders = folders.concat(data.item.folder).sort();
                }
            }
            setTimeout(() => closeDialog(tabname), 120);
            upsertPromptSetCard(tabname, data.item.id, previousId, data.html || "");
        } catch (error) {
            console.error("[ForgePromptSets] Save failed", error);
            setStatus(tabname, error.message || "Save failed.", true);
        }
    };

    window.forgePromptSetsToggleCard = function (event, tabname, promptSetId, promptText, negativeText) {
        prevent(event);

        const state = promptSetState(tabname);
        const existing = state[promptSetId];
        const promptArea = positiveTextarea(tabname);
        const negativeArea = negativeTextarea(tabname);

        if (existing) {
            const removedPrompt = removePromptSetText(promptArea, existing.prompt);
            const removedNegative = removePromptSetText(negativeArea, existing.negative);

            delete state[promptSetId];
            setCardActive(tabname, promptSetId, false);

            if (removedPrompt || removedNegative) return;
        }

        const promptSegment = addPromptSetText(promptArea, promptText);
        const negativeSegment = addPromptSetText(negativeArea, negativeText);

        state[promptSetId] = {
            prompt: promptSegment ? {text: promptText, segment: promptSegment} : null,
            negative: negativeSegment ? {text: negativeText, segment: negativeSegment} : null,
        };
        setCardActive(tabname, promptSetId, true);
    };

    window.forgePromptSetsDelete = async function (event, tabname, promptSetId) {
        prevent(event);
        if (!confirm("Delete this prompt set?")) return;

        try {
            const response = await fetch(endpoints.delete, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: promptSetId}),
            });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);

            const state = promptSetState(tabname);
            delete state[promptSetId];
            removePromptSetCard(tabname, promptSetId);
        } catch (error) {
            console.error("[ForgePromptSets] Delete failed", error);
            alert(error.message || "Delete failed.");
        }
    };

    window.forgePromptSetsDeleteCurrent = async function (event, tabname) {
        prevent(event);

        const originalId = field(tabname, ".forge-prompt-sets-original-id");
        const promptSetId = originalId ? originalId.value : "";
        if (!promptSetId) {
            setStatus(tabname, "Nothing to delete.", true);
            return;
        }

        if (!confirm("Delete this prompt set?")) return;

        try {
            const response = await fetch(endpoints.delete, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({id: promptSetId}),
            });
            const data = await response.json();
            if (!response.ok || !data.ok) throw new Error(data.error || response.statusText);

            const state = promptSetState(tabname);
            delete state[promptSetId];
            setCardActive(tabname, promptSetId, false);
            removePromptSetCard(tabname, promptSetId);
            closeDialog(tabname);
        } catch (error) {
            console.error("[ForgePromptSets] Delete current failed", error);
            setStatus(tabname, error.message || "Delete failed.", true);
        }
    };

    registerInitialPromptSetsRefresh();
})();
