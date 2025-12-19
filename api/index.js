import express from "express";
import net from "net";

const app = express();

const BLOCK_INTERNAL = true;           // SSRF basic
const LIMIT_BYTES = 40 * 1024 * 1024;  // 40MB
const TIMEOUT_MS = 30_000;

function isPrivateIp(ip) {
  if (!ip) return false;
  const v = ip.toLowerCase();
  if (v === "127.0.0.1" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return isPrivateIp(v.replace("::ffff:", ""));
  if (!net.isIP(v)) return false;
  if (/^10\./.test(v)) return true;
  if (/^192\.168\./.test(v)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(v)) return true;
  if (/^169\.254\./.test(v)) return true;
  if (/^0\./.test(v)) return true;
  if (v.startsWith("fc") || v.startsWith("fd")) return true;
  if (v.startsWith("fe80:")) return true;
  return false;
}

function safeName(name) {
  return String(name || "")
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 160);
}

function parseFilenameFromContentDisposition(cd) {
  if (!cd) return null;
  // RFC 5987: filename*=UTF-8''....
  const m5987 = cd.match(/filename\*\s*=\s*([^']*)''([^;]+)/i);
  if (m5987 && m5987[2]) {
    try {
      return decodeURIComponent(m5987[2]);
    } catch {
      return m5987[2];
    }
  }
  // filename="..."
  const m1 = cd.match(/filename\s*=\s*"([^"]+)"/i);
  if (m1 && m1[1]) return m1[1];
  // filename=...
  const m2 = cd.match(/filename\s*=\s*([^;]+)/i);
  if (m2 && m2[1]) return m2[1].trim();
  return null;
}

function guessNameFromUrl(u) {
  const base = u.pathname.split("/").filter(Boolean).pop() || "download.pdf";
  return base.includes(".") ? base : base + ".pdf";
}

app.get("/api/health", (_, res) => res.json({ ok: true }));

// AJAX: cek metadata file (content-type, filename, size)
app.get("/api/meta", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing ?url=" });

    let target;
    try { target = new URL(url); } catch { return res.status(400).json({ error: "Invalid URL" }); }

    if (!["http:", "https:"].includes(target.protocol)) {
      return res.status(400).json({ error: "Only http/https allowed" });
    }

    if (BLOCK_INTERNAL) {
      const host = target.hostname;
      if (net.isIP(host) && isPrivateIp(host)) return res.status(403).json({ error: "Blocked internal IP host" });
      if (host.toLowerCase() === "localhost") return res.status(403).json({ error: "Blocked localhost" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // HEAD dulu (kalau gagal, fallback GET)
    let upstream = await fetch(target.toString(), {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Vercel PDF Relay)" }
    }).catch(() => null);

    if (!upstream || !upstream.ok) {
      upstream = await fetch(target.toString(), {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (Vercel PDF Relay)" }
      });
    }

    clearTimeout(timer);

    if (!upstream.ok) return res.status(502).json({ error: `Upstream failed: ${upstream.status}` });

    const cd = upstream.headers.get("content-disposition") || "";
    const ct = upstream.headers.get("content-type") || "";
    const cl = upstream.headers.get("content-length");

    const fromHeader = parseFilenameFromContentDisposition(cd);
    const fallback = guessNameFromUrl(target);
    const filename = safeName(fromHeader || fallback);

    res.json({
      ok: true,
      filename,
      contentType: ct,
      contentLength: cl ? Number(cl) : null
    });
  } catch (e) {
    res.status(500).json({ error: "Server error", detail: String(e?.message || e) });
  }
});

// Download proxy (stream)
app.get("/api/pdf", async (req, res) => {
  try {
    const url = req.query.url;
    const filenameOverride = req.query.filename ? safeName(req.query.filename) : "";

    if (!url) return res.status(400).json({ error: "Missing ?url=" });

    let target;
    try { target = new URL(url); } catch { return res.status(400).json({ error: "Invalid URL" }); }

    if (!["http:", "https:"].includes(target.protocol)) {
      return res.status(400).json({ error: "Only http/https allowed" });
    }

    if (BLOCK_INTERNAL) {
      const host = target.hostname;
      if (net.isIP(host) && isPrivateIp(host)) return res.status(403).json({ error: "Blocked internal IP host" });
      if (host.toLowerCase() === "localhost") return res.status(403).json({ error: "Blocked localhost" });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const upstream = await fetch(target.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Vercel PDF Relay)",
        "Accept": "application/pdf,*/*"
      }
    }).finally(() => clearTimeout(timer));

    if (!upstream.ok) return res.status(502).json({ error: `Upstream failed: ${upstream.status}` });

    const cl = upstream.headers.get("content-length");
    if (cl && Number(cl) > LIMIT_BYTES) {
      return res.status(413).json({ error: `File too large (>${LIMIT_BYTES} bytes)` });
    }

    const cd = upstream.headers.get("content-disposition") || "";
    const ct = upstream.headers.get("content-type") || "application/pdf";

    const fromHeader = parseFilenameFromContentDisposition(cd);
    const fallback = guessNameFromUrl(target);
    let filename = safeName(filenameOverride || fromHeader || fallback);
    if (!filename.toLowerCase().endsWith(".pdf")) filename += ".pdf";

    res.setHeader("Content-Type", ct);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");

    const reader = upstream.body.getReader();
    let total = 0;

    res.on("close", () => { try { reader.cancel(); } catch {} });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > LIMIT_BYTES) {
        try { reader.cancel(); } catch {}
        return res.status(413).end("File too large");
      }
      res.write(Buffer.from(value));
    }

    res.end();
  } catch (e) {
    const msg = String(e?.name === "AbortError" ? "Upstream timeout" : (e?.message || e));
    res.status(500).json({ error: "Server error", detail: msg });
  }
});

export default app;
