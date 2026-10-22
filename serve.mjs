/**
 *    Name:         serve.mjs
 *    Description:  Local HTTP server to run HTMLSATURN in the browser. It is needed
 *                  because on file:// Chrome blocks Workers (the VDP1 rasterizer
 *                  on a separate thread does not start) and there is also no isolated
 *                  context, so there is no SharedArrayBuffer either.
 *                  By default it does NOT send COOP/COEP: that way the context is the SAME
 *                  one any simple hosting already gives and the emulator behaves the same. With
 *                  --sab they are sent, crossOriginIsolated becomes true and bus.js creates the
 *                  VDP1 VRAM, the framebuffer, the CRAM and the registers on SharedArrayBuffer
 *                  (see bus.js:138). Today that changes nothing visible -the snapshot to the worker
 *                  is still copied with .slice()-, but it is the groundwork for the step that does
 *                  matter: sharing those buffers with the worker WITHOUT copying 800 KB per frame.
 *                  Usage:  node serve.mjs [port] [options]
 *                    port       = 8080 by default
 *                    --lan      = listen on all interfaces (to test from another
 *                                 machine or a phone; by default only 127.0.0.1)
 *                    --sab      = send COOP/COEP (isolated context -> SharedArrayBuffer)
 *                    --cache    = allow the browser cache (no-store by default, so
 *                                 that a stale index.html does not stick between tests)
 *    Version:      0.1.0
 *    Created:      25-07-2026
 *    Modified:     25-07-2026
 *    Author:       Sebastian Toyos
 */

import { createServer } from "http";
import { createReadStream, statSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, extname, normalize, sep } from "path";
import { networkInterfaces } from "os";

const ROOT = dirname(fileURLToPath(import.meta.url));

const args       = process.argv.slice(2);
const port     = parseInt(args.find(a => /^\d+$/.test(a)) || "8080", 10);
const inLan      = args.includes("--lan");
const withSab     = args.includes("--sab");
const withCache   = args.includes("--cache");
const host       = inLan ? "0.0.0.0" : "127.0.0.1";

// MIME types. The .bin/.cue/.iso are there because the game library can also
// be read by fetch from roms/, not only through File System Access.
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".md":   "text/plain; charset=utf-8",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".gif":  "image/gif",
	".svg":  "image/svg+xml",
	".ico":  "image/x-icon",
	".wasm": "application/wasm",
	".bin":  "application/octet-stream",
	".cue":  "text/plain; charset=utf-8",
	".iso":  "application/octet-stream",
	".chd":  "application/octet-stream",
};

// Headers common to every response.
// - COOP/COEP (only with --sab): the pair that enables SharedArrayBuffer. It is off by
//   default so the server does not change the emulator's behavior on its own:
//   the project rule is to test ONE change at a time in the browser.
// - CORP: with COEP require-corp, EVERY subresource has to declare that it can be embedded;
//   since everything here comes from this same server, same-origin is enough and the tightest.
// - no-store: in development the worst bug is testing an index.html the browser had
//   cached and believing the change did not work.
function headersBase(type)
{
	const h = { "Content-Type": type };
	if(withSab)
	{
		h["Cross-Origin-Opener-Policy"]   = "same-origin";
		h["Cross-Origin-Embedder-Policy"] = "require-corp";
		h["Cross-Origin-Resource-Policy"] = "same-origin";
	}
	h["Cache-Control"] = withCache ? "public, max-age=60" : "no-store";
	return h;
}

// Resolves the URL to a file INSIDE the root. Returns FALSE if it escapes
// (path traversal with ../) or if it does not exist.
function resolvePath(url)
{
	let rel;
	try{ rel = decodeURIComponent(new URL(url, "http://x").pathname); }
	catch(e){ return false; }
	if(rel === "/") rel = "/index.html";
	const abs = normalize(join(ROOT, rel));
	if(abs !== ROOT && !abs.startsWith(ROOT + sep)) return false;
	let st;
	try{ st = statSync(abs); }
	catch(e){ return false; }
	if(st.isDirectory())
	{
		// A folder with an index.html inside is served; otherwise, a simple listing (handy for roms/).
		try{ const i = join(abs, "index.html"); statSync(i); return { abs: i, st: statSync(i) }; }
		catch(e){ return { abs, st, isDir: true }; }
	}
	return { abs, st };
}

function list(res, abs, url)
{
	const items = readdirSync(abs, { withFileTypes: true })
		.map(d => d.name + (d.isDirectory() ? "/" : ""))
		.sort();
	const base = url.endsWith("/") ? url : url + "/";
	const rows = items.map(n => "<li><a href=\"" + base + encodeURIComponent(n) + "\">" + n + "</a></li>").join("\n");
	const html = "<!doctype html><meta charset=utf-8><title>" + url + "</title>"
		+ "<body style=\"font:14px monospace;background:#111;color:#ddd;padding:24px\">"
		+ "<h2>" + url + "</h2><ul>" + rows + "</ul></body>";
	res.writeHead(200, headersBase(TYPES[".html"]));
	res.end(html);
}

const server = createServer((req, res) => {
	const r = resolvePath(req.url);
	if(!r)
	{
		res.writeHead(404, headersBase("text/plain; charset=utf-8"));
		res.end("404: " + req.url);
		return;
	}
	if(r.isDir){ list(res, r.abs, new URL(req.url, "http://x").pathname); return; }

	const type = TYPES[extname(r.abs).toLowerCase()] || "application/octet-stream";
	const h = headersBase(type);
	h["Accept-Ranges"] = "bytes";

	// Range: a disc's .bin files are hundreds of MB. Without this, asking for a piece downloads all of it.
	const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
	if(range)
	{
		const end   = range[2] ? parseInt(range[2], 10) : r.st.size - 1;
		const since = range[1] ? parseInt(range[1], 10) : Math.max(0, r.st.size - parseInt(range[2], 10));
		if(since >= r.st.size || end >= r.st.size || since > end)
		{
			h["Content-Range"] = "bytes */" + r.st.size;
			res.writeHead(416, h);
			res.end();
			return;
		}
		h["Content-Range"]  = "bytes " + since + "-" + end + "/" + r.st.size;
		h["Content-Length"] = end - since + 1;
		res.writeHead(206, h);
		if(req.method === "HEAD"){ res.end(); return; }
		createReadStream(r.abs, { start: since, end: end }).pipe(res);
		return;
	}

	h["Content-Length"] = r.st.size;
	res.writeHead(200, h);
	if(req.method === "HEAD"){ res.end(); return; }
	createReadStream(r.abs).pipe(res);
});

server.on("error", (e) => {
	if(e.code === "EADDRINUSE")
	{
		console.error("Port " + port + " is already in use. Try: node serve.mjs " + (port + 1));
		process.exit(1);
	}
	throw e;
});

server.listen(port, host, () => {
	console.log("");
	console.log("  HTMLSATURN served from " + ROOT);
	console.log("");
	console.log("    http://localhost:" + port + "/index.html");
	if(inLan)
	{
		const nets = networkInterfaces();
		for(const name of Object.keys(nets))
			for(const n of nets[name] || [])
				if(n.family === "IPv4" && !n.internal)
					console.log("    http://" + n.address + ":" + port + "/index.html   (" + name + ")");
	}
	console.log("");
	console.log("  VDP1 worker:          enabled (needs http://, on file:// Chrome blocks it)");
	console.log("  SharedArrayBuffer:    " + (withSab ? "YES (COOP+COEP set)" : "no (--sab to turn it on)"));
	console.log("  Browser cache:        " + (withCache ? "allowed (--cache)" : "off (no-store)"));
	console.log("");
	console.log("  Ctrl+C to stop.");
	console.log("");
});
