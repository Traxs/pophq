// Minimal stand-in for Discord webhooks in local development.
// POST /api/webhooks/<id>/<token>  -> stores the message, returns 204 like Discord
// GET  /messages                   -> all stored messages, newest last
// DELETE /messages                 -> clears the store
import { createServer } from "node:http";

const messages = [];

createServer((req, res) => {
  if (req.method === "GET" && req.url === "/messages") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(messages));
    return;
  }
  if (req.method === "DELETE" && req.url === "/messages") {
    messages.length = 0;
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/api/webhooks/")) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        messages.push({ receivedAt: new Date().toISOString(), path: req.url, body: JSON.parse(body) });
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }
  res.writeHead(404).end();
}).listen(8082, () => console.log("discord-sink listening on :8082"));
