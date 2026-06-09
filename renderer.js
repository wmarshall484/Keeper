window.addEventListener('DOMContentLoaded', async () => {
    const fileList = document.getElementById('file-list');
    const upButton = document.getElementById('up-button');
    const chartContainer = document.getElementById('chart-container');
    let contextMenu = null;
    let editor = null;
    let editorReady = false;
    let selectedIndices = new Set(); // indices into renderedItems that are selected
    let anchorIndex = null;          // anchor for shift-range selection
    let renderedItems = [];          // { el, file, filePath } in display order
    let renderedDir = null; // Path of the directory currently shown in the file list.
    const dirScrollPositions = new Map(); // Remembered scroll position per directory.

    // Decorations collection used to highlight the matched CODEOWNERS line.
    let ruleHighlight = null;

    // Wait briefly for the Monaco editor to finish loading. File clicks can
    // fire before the (async) editor initialization completes; without this a
    // click in that window would be silently dropped.
    function waitForEditor(timeoutMs = 4000) {
        return new Promise((resolve) => {
            if (editor && editorReady) {
                resolve(true);
                return;
            }
            const start = Date.now();
            const id = setInterval(() => {
                if (editor && editorReady) {
                    clearInterval(id);
                    resolve(true);
                } else if (Date.now() - start >= timeoutMs) {
                    clearInterval(id);
                    resolve(false);
                }
            }, 50);
        });
    }

    // Function to scroll editor to (and highlight) the matching rule's line.
    async function scrollToRuleLine(filePath, isDirectory) {
        console.log('scrollToRuleLine called for:', filePath, 'isDirectory:', isDirectory);

        if (!(await waitForEditor())) {
            console.log('Editor not ready yet');
            return;
        }

        const ruleInfo = await window.electronAPI.getRuleInfo(filePath, isDirectory);
        console.log('Rule info received:', ruleInfo);

        const model = editor.getModel();

        if (!ruleInfo || !ruleInfo.lineNumber) {
            // No matching rule — clear any previous highlight so the absence of
            // a match is visually clear.
            if (ruleHighlight) {
                ruleHighlight.clear();
            }
            console.log('No matching rule for this item');
            return;
        }

        // Clamp to the buffer's current line count in case it was edited.
        const lineNumber = model
            ? Math.min(ruleInfo.lineNumber, model.getLineCount())
            : ruleInfo.lineNumber;

        try {
            editor.revealLineInCenter(lineNumber);
            editor.setPosition({ lineNumber, column: 1 });

            // Whole-line highlight so the match is obvious even when the line is
            // already on screen (a short CODEOWNERS file doesn't need to scroll,
            // so a plain cursor move would be invisible).
            const decoration = {
                range: new monaco.Range(lineNumber, 1, lineNumber, 1),
                options: { isWholeLine: true, className: 'keeper-rule-highlight' }
            };
            if (ruleHighlight) {
                ruleHighlight.set([decoration]);
            } else {
                ruleHighlight = editor.createDecorationsCollection([decoration]);
            }

            console.log('Highlighted rule line:', lineNumber);
        } catch (error) {
            console.error('Error highlighting rule line:', error);
        }
    }

    // Reload the CODEOWNERS editor from disk (after an assign/remove/save),
    // preserving the scroll/cursor position so the update isn't jarring.
    async function reloadEditorContent() {
        if (!editor) {
            return;
        }
        const result = await window.electronAPI.getCodeownersContent();
        if (result.success) {
            const viewState = editor.saveViewState();
            editor.setValue(result.content);
            if (viewState) {
                editor.restoreViewState(viewState);
            }
        }
    }

    // Function to show directory selection UI
    function showDirectorySelectionUI() {
        // Hide normal UI elements
        upButton.style.display = 'none';
        document.getElementById('file-list-header').style.display = 'none';
        document.querySelector('.hint-text').style.display = 'none';
        chartContainer.parentElement.style.display = 'none';
        document.querySelector('.info-pane').style.display = 'none';

        // Show selection button
        fileList.innerHTML = `
            <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 20px;">
                <div style="font-size: 18px; color: #999;">No repository selected</div>
                <button id="select-repo-button" style="
                    padding: 12px 24px;
                    font-size: 16px;
                    background-color: #0e639c;
                    color: white;
                    border: none;
                    border-radius: 4px;
                    cursor: pointer;
                    transition: background-color 0.2s;
                ">Select Repository</button>
            </div>
        `;

        const selectButton = document.getElementById('select-repo-button');
        selectButton.addEventListener('mouseenter', () => {
            selectButton.style.backgroundColor = '#1177bb';
        });
        selectButton.addEventListener('mouseleave', () => {
            selectButton.style.backgroundColor = '#0e639c';
        });
        selectButton.addEventListener('click', async () => {
            const result = await window.electronAPI.selectDirectory();
            if (result.success) {
                // Reload the entire window to show the new directory
                window.location.reload();
            }
        });
    }

    // Check if we need to show directory selection UI
    const needsSelection = await window.electronAPI.needsDirectorySelection();
    if (needsSelection) {
        showDirectorySelectionUI();
        return;
    }

    // Setup resizable panes
    function setupResizablePane(handleId, leftPaneClass, rightPaneClass) {
        const handle = document.getElementById(handleId);
        const leftPane = document.querySelector(`.${leftPaneClass}`);
        const rightPane = document.querySelector(`.${rightPaneClass}`);

        let isResizing = false;
        let startX = 0;
        let startLeftWidth = 0;
        let startRightWidth = 0;

        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startLeftWidth = leftPane.offsetWidth;
            startRightWidth = rightPane.offsetWidth;

            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const delta = e.clientX - startX;
            const newLeftWidth = startLeftWidth + delta;
            const newRightWidth = startRightWidth - delta;

            // Apply min-width constraints
            const leftMinWidth = parseInt(getComputedStyle(leftPane).minWidth) || 200;
            const rightMinWidth = parseInt(getComputedStyle(rightPane).minWidth) || 200;

            if (newLeftWidth >= leftMinWidth && newRightWidth >= rightMinWidth) {
                leftPane.style.width = newLeftWidth + 'px';
                if (rightPane.style.flexGrow) {
                    // Right pane is the middle pane with flex-grow
                    rightPane.style.flexGrow = '0';
                }
                rightPane.style.width = newRightWidth + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    setupResizablePane('resize-handle-1', 'info-pane', 'middle-pane');
    setupResizablePane('resize-handle-2', 'middle-pane', 'right-pane');

    // --- Resizer for File List Owner Column ---
    let fileListOwnerWidth = 170; // Default width in px

    function updateOwnerWidthStyle(width) {
        let styleElement = document.getElementById('file-list-owner-style');
        if (!styleElement) {
            styleElement = document.createElement('style');
            styleElement.id = 'file-list-owner-style';
            document.head.appendChild(styleElement);
        }
        styleElement.textContent = `
            .owner-header, .file-item .owner {
                width: ${width}px;
            }
        `;
    }

    function setupOwnerResizer(handleId) {
        const handle = document.getElementById(handleId);
        if (!handle) return;

        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = fileListOwnerWidth;

            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            // The file list grows from left to right, but the owner column is on the right.
            // So we need to invert the delta. A positive delta (mouse moves right) should shrink the column.
            const delta = e.clientX - startX;
            let newWidth = startWidth - delta;

            const minWidth = 80;
            const maxWidth = 500;
            newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));

            fileListOwnerWidth = newWidth;
            updateOwnerWidthStyle(newWidth);
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }

    // Insert the handle into the DOM and set up the resizer
    const fileListHeader = document.getElementById('file-list-header');
    if (fileListHeader) {
        const nameHeader = fileListHeader.querySelector('.name-header');
        if (nameHeader) {
            const handle = document.createElement('div');
            handle.id = 'file-list-resize-handle';
            handle.className = 'resize-handle';
            nameHeader.insertAdjacentElement('afterend', handle);

            updateOwnerWidthStyle(fileListOwnerWidth); // Set initial width
            setupOwnerResizer('file-list-resize-handle');
        }
    }
    // --- End Resizer Setup ---

    // Custom prompt dialog functionality
    const promptOverlay = document.getElementById('custom-prompt-overlay');
    const ownerInput = document.getElementById('owner-input');
    const promptOk = document.getElementById('prompt-ok');
    const promptCancel = document.getElementById('prompt-cancel');

    function showCustomPrompt() {
        return new Promise((resolve) => {
            ownerInput.value = '';
            promptOverlay.style.display = 'flex';
            ownerInput.focus();

            const handleOk = () => {
                const value = ownerInput.value.trim();
                promptOverlay.style.display = 'none';
                cleanup();
                resolve(value);
            };

            const handleCancel = () => {
                promptOverlay.style.display = 'none';
                cleanup();
                resolve(null);
            };

            const handleKeydown = (e) => {
                if (e.key === 'Enter') {
                    handleOk();
                } else if (e.key === 'Escape') {
                    handleCancel();
                }
            };

            const cleanup = () => {
                promptOk.removeEventListener('click', handleOk);
                promptCancel.removeEventListener('click', handleCancel);
                ownerInput.removeEventListener('keydown', handleKeydown);
            };

            promptOk.addEventListener('click', handleOk);
            promptCancel.addEventListener('click', handleCancel);
            ownerInput.addEventListener('keydown', handleKeydown);
        });
    }

    upButton.addEventListener('click', async () => {
        const currentDirectory = await window.electronAPI.getDirectory();
        const parentDirectory = await window.electronAPI.getParentDirectory(currentDirectory);
        if (parentDirectory !== currentDirectory) {
            window.electronAPI.navigateTo(parentDirectory);
        }
    });

    // Close context menu when clicking anywhere
    document.addEventListener('click', () => {
        if (contextMenu) {
            contextMenu.remove();
            contextMenu = null;
        }
    });

    // Apply the .selected class to whichever rows are currently selected.
    function updateSelectionStyles() {
        renderedItems.forEach((item, i) => {
            item.el.classList.toggle('selected', selectedIndices.has(i));
        });
    }

    // The current selection as context-menu targets, in display order.
    function selectedTargets() {
        return [...selectedIndices].sort((a, b) => a - b).map(i => ({
            filePath: renderedItems[i].filePath,
            fileName: renderedItems[i].file.name,
            isDirectory: renderedItems[i].file.isDirectory,
        }));
    }

    // Left-click selection, with Cmd/Ctrl-click to toggle and Shift-click to
    // range-select (standard file-manager behavior).
    async function handleItemClick(index, e) {
        const item = renderedItems[index];
        if (e.metaKey || e.ctrlKey) {
            if (selectedIndices.has(index)) selectedIndices.delete(index);
            else selectedIndices.add(index);
            anchorIndex = index;
        } else if (e.shiftKey && anchorIndex !== null) {
            selectedIndices = new Set();
            const lo = Math.min(anchorIndex, index);
            const hi = Math.max(anchorIndex, index);
            for (let k = lo; k <= hi; k++) selectedIndices.add(k);
        } else {
            selectedIndices = new Set([index]);
            anchorIndex = index;
        }
        updateSelectionStyles();
        // Show the rule for the row just clicked.
        await scrollToRuleLine(item.filePath, item.file.isDirectory);
    }

    async function handleItemContextMenu(index, e) {
        e.preventDefault();
        e.stopPropagation();
        // Right-clicking outside the current selection selects just that row;
        // right-clicking inside a multi-selection keeps the whole selection.
        if (!selectedIndices.has(index)) {
            selectedIndices = new Set([index]);
            anchorIndex = index;
            updateSelectionStyles();
        }
        const item = renderedItems[index];
        await scrollToRuleLine(item.filePath, item.file.isDirectory);
        await showContextMenu(e.pageX, e.pageY, selectedTargets());
    }

    async function showContextMenu(x, y, targets) {
        // Remove existing context menu if any
        if (contextMenu) {
            contextMenu.remove();
            contextMenu = null;
        }

        if (!targets || targets.length === 0) {
            return;
        }

        const owners = await window.electronAPI.getAllOwners();

        if (owners.length === 0) {
            return; // No owners to assign
        }

        // Refresh the file list, chart, and editor after a change, preserving
        // the file-list scroll position.
        const refreshAfter = async () => {
            const scrollTop = fileList.scrollTop;
            await renderAll();
            await reloadEditorContent();
            const last = targets[targets.length - 1];
            await scrollToRuleLine(last.filePath, last.isDirectory);
            fileList.scrollTop = scrollTop;
        };
        const assignAll = async (owner) => {
            try {
                await window.electronAPI.assignOwners(targets, owner);
                await refreshAfter();
            } catch (error) {
                console.error('Failed to assign owner:', error);
                alert('Failed to assign owner: ' + error.message);
            }
        };
        const removeAll = async () => {
            try {
                await window.electronAPI.removeOwners(targets);
                await refreshAfter();
            } catch (error) {
                console.error('Failed to remove owner:', error);
                alert('Failed to remove owner: ' + error.message);
            }
        };

        // Create context menu
        contextMenu = document.createElement('div');
        contextMenu.className = 'context-menu';

        const header = document.createElement('div');
        header.className = 'context-menu-header';
        header.textContent = targets.length === 1
            ? `Assign owner to ${targets[0].fileName}${targets[0].isDirectory ? '/' : ''}`
            : `Assign owner to ${targets.length} items`;
        contextMenu.appendChild(header);

        owners.forEach(owner => {
            const item = document.createElement('div');
            item.className = 'context-menu-item';
            item.textContent = owner;
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                contextMenu.remove();
                contextMenu = null;
                await assignAll(owner);
            });
            contextMenu.appendChild(item);
        });

        // Add separator
        const separator1 = document.createElement('div');
        separator1.className = 'context-menu-separator';
        contextMenu.appendChild(separator1);

        // Add "Add new owner" option
        const addNewItem = document.createElement('div');
        addNewItem.className = 'context-menu-item';
        addNewItem.textContent = 'Add new owner...';
        addNewItem.addEventListener('click', async (e) => {
            e.stopPropagation();
            contextMenu.remove();
            contextMenu = null;

            const newOwner = await showCustomPrompt();
            if (newOwner && newOwner !== '') {
                // Prevent adding <unset> as an owner
                if (newOwner === '<unset>') {
                    alert('Cannot use "<unset>" as an owner name. This is reserved for files without owners.');
                    return;
                }
                await assignAll(newOwner);
            }
        });
        contextMenu.appendChild(addNewItem);

        // Add separator
        const separator2 = document.createElement('div');
        separator2.className = 'context-menu-separator';
        contextMenu.appendChild(separator2);

        // Add "Remove owner" option
        const removeItem = document.createElement('div');
        removeItem.className = 'context-menu-item context-menu-item-remove';
        removeItem.textContent = targets.length === 1 ? 'Remove owner' : 'Remove owner from all';
        removeItem.addEventListener('click', async (e) => {
            e.stopPropagation();
            contextMenu.remove();
            contextMenu = null;
            await removeAll();
        });
        contextMenu.appendChild(removeItem);

        // Add to DOM temporarily to measure dimensions
        contextMenu.style.visibility = 'hidden';
        document.body.appendChild(contextMenu);

        // Get menu dimensions
        const menuWidth = contextMenu.offsetWidth;
        const menuHeight = contextMenu.offsetHeight;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        // Adjust position to keep menu within viewport
        let finalX = x;
        let finalY = y;

        // Check if menu overflows right edge
        if (x + menuWidth > windowWidth) {
            finalX = windowWidth - menuWidth - 10; // 10px padding from edge
        }

        // Check if menu overflows bottom edge
        if (y + menuHeight > windowHeight) {
            finalY = windowHeight - menuHeight - 10; // 10px padding from edge
        }

        // Ensure menu doesn't go off top or left edges
        finalX = Math.max(10, finalX);
        finalY = Math.max(10, finalY);

        // Set final position and make visible
        contextMenu.style.left = finalX + 'px';
        contextMenu.style.top = finalY + 'px';
        contextMenu.style.visibility = 'visible';
    }

    let chartLabelWidth = 150; // Default width

    // Function to dynamically update the CSS for chart labels
    function updateChartLabelWidthStyle(width) {
        let styleElement = document.getElementById('chart-label-style');
        if (!styleElement) {
            styleElement = document.createElement('style');
            styleElement.id = 'chart-label-style';
            document.head.appendChild(styleElement);
        }
        // Set both min and max width to enforce the size
        styleElement.textContent = `
            .chart-row .label {
                min-width: ${width}px;
                max-width: ${width}px;
            }
            .chart-label-header {
                min-width: ${width}px;
                max-width: ${width}px;
            }
        `;
    }

    function setupChartLabelResizer() {
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        chartContainer.addEventListener('mousedown', (e) => {
            // Only trigger if the user clicks on the resize handle
            if (e.target.id !== 'chart-resize-handle') {
                return;
            }

            isResizing = true;
            startX = e.clientX;
            startWidth = chartLabelWidth; // Use the global width

            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const delta = e.clientX - startX;
            let newWidth = startWidth + delta;

            // Apply constraints
            const minWidth = 80;
            const maxWidth = 500;
            newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));

            chartLabelWidth = newWidth; // Update global state
            updateChartLabelWidthStyle(newWidth); // Update style tag
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        });
    }


    function updateChartDisplay(stats) {
        const wasEmpty = chartContainer.querySelector('#chart-rows') === null;

        if (stats.length === 0) {
            chartContainer.innerHTML = '<p>No ownership information to display for this directory.</p>';
            return;
        }


        // Only build the header if it's the first time
        if (wasEmpty) {
            chartContainer.innerHTML = ''; // Clear existing content

            // 1. Create Header
            const header = document.createElement('div');
            header.id = 'chart-header';

            const labelHeader = document.createElement('div');
            labelHeader.className = 'chart-label-header';
            labelHeader.textContent = 'Owner';
            header.appendChild(labelHeader);

            const resizeHandle = document.createElement('div');
            resizeHandle.id = 'chart-resize-handle';
            resizeHandle.className = 'resize-handle';
            header.appendChild(resizeHandle);

            const barHeader = document.createElement('div');
            barHeader.className = 'chart-bar-header';
            barHeader.textContent = 'Percent';
            header.appendChild(barHeader);

            const countHeader = document.createElement('div');
            countHeader.className = 'chart-count-header';
            countHeader.textContent = 'Count';
            header.appendChild(countHeader);

            chartContainer.appendChild(header);

            // 2. Create container for scrollable rows
            const rowsContainer = document.createElement('div');
            rowsContainer.id = 'chart-rows';
            chartContainer.appendChild(rowsContainer);
        }

        const rowsContainer = chartContainer.querySelector('#chart-rows');
        rowsContainer.innerHTML = ''; // Clear only the rows

        // 3. Populate rows
        const sortedStats = stats.sort((a, b) => b.percentage - a.percentage);
        sortedStats.forEach(stat => {
            const row = document.createElement('div');
            row.className = 'chart-row';

            const label = document.createElement('div');
            label.className = 'label';
            if (stat.owner === '<unset>') {
                label.classList.add('unset');
            }
            label.textContent = stat.owner;
            label.title = stat.owner;

            const barContainer = document.createElement('div');
            barContainer.className = 'chart-bar-container';

            const bar = document.createElement('div');
            bar.className = 'chart-bar';
            bar.style.width = `${stat.percentage}%`;

            const percentage = document.createElement('div');
            percentage.className = 'percentage';
            percentage.textContent = `${stat.percentage.toFixed(1)}%`;

            const count = document.createElement('div');
            count.className = 'count';
            count.textContent = stat.count.toLocaleString();

            bar.appendChild(percentage);
            barContainer.appendChild(bar);
            row.appendChild(label);
            row.appendChild(barContainer);
            row.appendChild(count);
            rowsContainer.appendChild(row);
        });
    }

    // Set initial width on load & set up resizer ONCE
    updateChartLabelWidthStyle(chartLabelWidth);
    setupChartLabelResizer();

    async function renderChart(codeownersFound) {
        if (!codeownersFound) {
            chartContainer.innerHTML = '<p style="color: #f48771; text-align: center;">CODEOWNERS file not found in the project root.</p>';
            return;
        }

        chartContainer.innerHTML = 'Loading...';
        const directory = await window.electronAPI.getDirectory();
        const stats = await window.electronAPI.getOwnershipStats(directory);

        updateChartDisplay(stats);
    }

    async function renderFiles() {
        // Remember where we were in the directory we're leaving, so the position
        // can be restored when navigating back up to it (or after a save, which
        // re-renders the same directory).
        if (renderedDir !== null) {
            dirScrollPositions.set(renderedDir, fileList.scrollTop);
        }

        fileList.innerHTML = ''; // Clear the list
        selectedIndices = new Set(); // Clear selection
        anchorIndex = null;
        renderedItems = [];

        // Remove any lingering context menu
        if (contextMenu) {
            contextMenu.remove();
            contextMenu = null;
        }

        const directory = await window.electronAPI.getDirectory();
        const files = await window.electronAPI.getFiles(directory);
        renderedDir = directory;

        if (files.length === 0) {
            fileList.innerHTML = '<p>This directory is empty.</p>';
            return;
        }

        const dirBase = directory.replace(/\/+$/, '');

        files.forEach((file, index) => {
            const fileItem = document.createElement('div');
            fileItem.className = 'file-item';

            const icon = document.createElement('div');
            icon.className = 'icon';
            icon.textContent = file.isDirectory ? '📁' : '📄';

            const name = document.createElement('div');
            name.className = 'name';
            name.textContent = file.name;

            fileItem.appendChild(icon);
            fileItem.appendChild(name);

            const owner = document.createElement('div');
            owner.className = 'owner';

            if (file.owner) {
                const owners = file.owner.split(' ').filter(o => o);
                owner.title = owners.join(', '); // Keep tooltip for readability

                owners.forEach(ownerName => {
                    const ownerTag = document.createElement('span');
                    ownerTag.className = 'owner-tag';
                    ownerTag.textContent = ownerName;
                    owner.appendChild(ownerTag);
                });
            } else {
                owner.textContent = '<unset>';
                owner.classList.add('unset');
            }
            fileItem.appendChild(owner);

            const filePath = `${dirBase}/${file.name}`;
            renderedItems.push({ el: fileItem, file, filePath });

            // Single-click selects (with Cmd/Ctrl/Shift modifiers for multi-select).
            fileItem.addEventListener('click', (e) => handleItemClick(index, e));

            // Double-click navigates into directories.
            fileItem.addEventListener('dblclick', () => {
                if (file.isDirectory) {
                    window.electronAPI.navigateTo(filePath);
                }
            });

            // Right-click opens the assign/remove menu for the selection.
            fileItem.addEventListener('contextmenu', (e) => handleItemContextMenu(index, e));

            fileList.appendChild(fileItem);
        });

        // Restore the saved scroll position for this directory (top on first visit).
        fileList.scrollTop = dirScrollPositions.get(directory) || 0;
    }

    async function updateCurrentPath() {
        const initialDirectory = await window.electronAPI.getInitialDirectory();
        const currentDirectory = await window.electronAPI.getDirectory();
        const currentPathElement = document.getElementById('current-path');

        if (currentPathElement) {
            // Show relative path from initial directory
            const relativePath = currentDirectory.replace(initialDirectory, '') || '/';
            currentPathElement.textContent = relativePath;
        }
    }

    async function renderAll() {
        const initialDirectory = await window.electronAPI.getInitialDirectory();
        const currentDirectory = await window.electronAPI.getDirectory();

        console.log('Initial Directory:', initialDirectory);
        console.log('Current Directory:', currentDirectory);
        console.log('Are directories equal?', currentDirectory === initialDirectory);

        upButton.disabled = (currentDirectory === initialDirectory);

        const codeownersFound = await window.electronAPI.wasCodeownersFound();

        await Promise.all([renderFiles(), renderChart(codeownersFound), updateCurrentPath()]);
    }

    await renderAll();

    // "Ruby files only" toggle — re-index (Ruby files only) and re-filter the
    // file navigator. The main process invalidates stats + restarts indexing.
    const rubyOnlyCheckbox = document.getElementById('ruby-only-checkbox');
    if (rubyOnlyCheckbox) {
        rubyOnlyCheckbox.checked = await window.electronAPI.getRubyOnly();
        rubyOnlyCheckbox.addEventListener('change', async () => {
            await window.electronAPI.setRubyOnly(rubyOnlyCheckbox.checked);
            await renderAll();
        });
    }

    window.electronAPI.onDirectoryChanged(async () => {
        await renderAll();
        await reloadEditorContent();
    });

    // Listen for incremental stats updates
    window.electronAPI.onStatsProgress(async (dirPath, partialStats) => {
        const currentDir = await window.electronAPI.getDirectory();
        // Only update if this is still the current directory
        if (dirPath === currentDir) {
            console.log('Received progress update with', partialStats.length, 'owners');
            updateChartDisplay(partialStats);
        }
    });

    // Debug info - log to console
    const debugInfo = await window.electronAPI.getDebugInfo();
    console.log('=== DEBUG INFO ===');
    console.log('process.argv:', debugInfo.argv);
    console.log('app.isPackaged:', debugInfo.isPackaged);
    console.log('initialDirectory:', debugInfo.initialDirectory);
    console.log('projectRoot:', debugInfo.projectRoot);
    console.log('cwd:', debugInfo.cwd);
    console.log('==================');

    // Initialize Monaco Editor
    console.log('Attempting to initialize Monaco Editor...');
    require(['vs/editor/editor.main'], async function() {
        const editorContainer = document.getElementById('editor-container');

        // Register a lightweight CODEOWNERS syntax: comments, owners, and glob
        // wildcards. Owners use the same light-blue as the owner chips in the
        // file list, for visual consistency.
        if (!monaco.languages.getLanguages().some(l => l.id === 'codeowners')) {
            monaco.languages.register({ id: 'codeowners' });
            monaco.languages.setMonarchTokensProvider('codeowners', {
                defaultToken: '',
                tokenizer: {
                    root: [
                        [/#.*/, 'comment'],
                        [/@[\w./-]+/, 'owner'],             // @user or @org/team
                        [/[\w.+-]+@[\w.-]+\.\w+/, 'owner'], // email owners
                        [/\*\*|\*|\?|\[[^\]]*\]/, 'glob'],  // glob wildcards
                    ],
                },
            });
            monaco.editor.defineTheme('codeowners-dark', {
                base: 'vs-dark',
                inherit: true,
                rules: [
                    { token: 'comment', foreground: '6A9955', fontStyle: 'italic' },
                    { token: 'owner', foreground: '9CDCFE' },
                    { token: 'glob', foreground: 'D7BA7D' },
                ],
                colors: {},
            });
        }

        // Get CODEOWNERS content
        const result = await window.electronAPI.getCodeownersContent();

        if (!result.success) {
            editorContainer.innerHTML = `<div style="padding: 20px; color: #f48771;">${result.error}</div>`;
            return;
        }

        // Create Monaco Editor instance
        editor = monaco.editor.create(editorContainer, {
            value: result.content,
            language: 'codeowners',
            theme: 'codeowners-dark',
            automaticLayout: true,
            lineNumbers: 'on',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 13,
            wordWrap: 'off'
        });

        // Mark editor as ready
        editorReady = true;
        console.log('Monaco Editor has been successfully initialized.');
        console.log('Monaco editor initialized and ready');

        // Add save shortcut (Ctrl+S or Cmd+S)
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, async function() {
            const content = editor.getValue();
            const saveResult = await window.electronAPI.saveCodeownersContent(content);

            if (!saveResult.success) {
                alert('Failed to save: ' + saveResult.error);
            } else {
                console.log('CODEOWNERS file saved successfully');
            }
        });
    });
});
