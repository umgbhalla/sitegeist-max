/**
 * This code gets stringified and injected into the page context.
 * Creates a minimal full-viewport abort toolbar for browser-control runs.
 */
export function createOverlayScript(taskName: string, windowId?: number): string {
	// Embed the owning window id literally ONLY when it is a finite number; otherwise
	// emit `undefined` so the overlay omits it from the abort message and background
	// falls back to sender.tab.windowId instead of routing to a bogus sentinel id.
	const windowIdLiteral = typeof windowId === "number" && Number.isFinite(windowId) ? String(windowId) : "undefined";
	return `
(function() {
	// Check if overlay already exists (prevent duplicates)
	if (document.getElementById('sitegeist-repl-overlay')) {
		return;
	}

	// Create overlay container
	const overlay = document.createElement('div');
	overlay.id = 'sitegeist-repl-overlay';
	overlay.style.cssText = \`
		position: fixed;
		top: 0;
		left: 0;
		width: 100vw;
		height: 100vh;
		z-index: 2147483647;
		pointer-events: none;
		font-family: system-ui, -apple-system, sans-serif;
	\`;

	// Create toolbar
	const toolbar = document.createElement('div');
	toolbar.style.cssText = \`
		position: absolute;
		bottom: 24px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 16px;
		background: rgba(0, 0, 0, 0.9);
		backdrop-filter: blur(8px);
		border-radius: 8px;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
		pointer-events: auto;
		z-index: 1;
	\`;

	// Task name label
	const label = document.createElement('span');
	label.textContent = '${taskName.replace(/'/g, "\\'")}';
	label.style.cssText = \`
		color: rgba(255, 255, 255, 0.9);
		font-size: 14px;
		font-weight: 500;
	\`;

	// Abort button
	const abortBtn = document.createElement('button');
	abortBtn.textContent = 'Stop';
	abortBtn.style.cssText = \`
		padding: 6px 12px;
		background: rgba(239, 68, 68, 0.9);
		color: white;
		border: none;
		border-radius: 4px;
		font-size: 13px;
		font-weight: 500;
		cursor: pointer;
		transition: background 0.2s;
	\`;
	abortBtn.onmouseover = () => {
		abortBtn.style.background = 'rgba(220, 38, 38, 1)';
	};
	abortBtn.onmouseout = () => {
		abortBtn.style.background = 'rgba(239, 68, 68, 0.9)';
	};
	abortBtn.onclick = async () => {
		// Send message BEFORE removing overlay
		try {
			// Carry the owning window id so background routes the abort to the
			// sidepanel that started THIS run, never broadcasting to others.
			// windowId may be undefined here; background then falls back to sender.tab.windowId.
			await chrome.runtime.sendMessage({ type: 'abort-repl', windowId: ${windowIdLiteral} });
		} catch (error) {
			console.error('[Overlay] sendMessage failed:', error);
		}

		// Remove overlay after message sent
		overlay.remove();
	};

	// Assemble toolbar
	toolbar.appendChild(label);
	toolbar.appendChild(abortBtn);

	// Assemble overlay
	overlay.appendChild(toolbar);

	// Inject into page
	document.body.appendChild(overlay);
})();
`;
}

/**
 * Code to remove the overlay from the page.
 */
export function removeOverlayScript(): string {
	return `
(function() {
	const overlay = document.getElementById('sitegeist-repl-overlay');
	if (overlay) {
		overlay.remove();
	}
})();
`;
}
