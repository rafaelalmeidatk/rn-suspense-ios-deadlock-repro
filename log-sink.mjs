import { appendFileSync } from "node:fs"
import { createServer } from "node:http"

const port = Number(process.env.PORT ?? 4002)
const file = process.env.LOG_FILE ?? "device.log"

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/log") {
    res.writeHead(404).end()
    return
  }
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    const receivedAt = new Date().toISOString()
    const lines = body
      .split("\n")
      .filter(Boolean)
      .map((line) => `${receivedAt} ${line}`)
    appendFileSync(file, lines.join("\n") + "\n")
    process.stdout.write(lines.join("\n") + "\n")
    res.writeHead(204).end()
  })
}).listen(port, () => console.info(`log sink on :${port} -> ${file}`))
