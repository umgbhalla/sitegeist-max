import { existsSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Watch both browser directories
const distDirChrome = join(__dirname, "..", "dist-chrome");

// The panel's only stylesheet. Never trigger a reload until it exists and is
// non-empty, otherwise the panel can reload CSS-less between esbuild's write
// and Tailwind's output.
const cssOutput = join(distDirChrome, "app.css");
const cssIsReady = () => existsSync(cssOutput) && statSync(cssOutput).size > 0;

const PORT = 8765; // Fixed port for WebSocket server
const server = createServer();
const wss = new WebSocketServer({ server });

const clients = new Set();

// WebSocket connection handling
wss.on("connection", (ws) => {
	console.log("[DevServer] Client connected");
	clients.add(ws);

	ws.on("close", () => {
		console.log("[DevServer] Client disconnected");
		clients.delete(ws);
	});

	ws.on("error", (error) => {
		console.error("[DevServer] WebSocket error:", error);
		clients.delete(ws);
	});

	// Send initial connection confirmation
	ws.send(JSON.stringify({ type: "connected" }));
});

// Watch for changes in both dist directories
const watcherChrome = watch(distDirChrome, { recursive: true }, (_eventType, filename) => {
	if (filename) {
		// Gate reloads until app.css is present & non-empty, so the panel never
		// reloads in a CSS-less state during a build.
		if (!cssIsReady()) {
			console.log(`[DevServer] Chrome file changed: ${filename} (waiting for app.css before reload)`);
			return;
		}

		console.log(`[DevServer] Chrome file changed: ${filename}`);

		// Send reload message to all connected clients
		const message = JSON.stringify({
			type: "reload",
			browser: "chrome",
			file: filename,
		});
		clients.forEach((client) => {
			if (client.readyState === 1) {
				// OPEN state
				client.send(message);
			}
		});
	}
});

// Start server
server.listen(PORT, () => {
	console.log(`[DevServer] WebSocket server running on ws://localhost:${PORT}`);
	console.log(`[DevServer] Watching for changes in ${distDirChrome}`);
});

// Graceful shutdown
process.on("SIGINT", () => {
	console.log("\n[DevServer] Shutting down...");
	watcherChrome.close();
	for (const client of clients) {
		client.close();
	}
	server.close(() => {
		process.exit(0);
	});
});
