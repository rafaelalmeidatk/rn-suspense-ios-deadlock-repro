import { JSDOM } from "jsdom"

const dom = new JSDOM("<!doctype html><div id=root></div>")
globalThis.window = dom.window
globalThis.document = dom.window.document

const { createElement: h, Suspense, useEffect, useState } = await import("react")
const { createRoot } = await import("react-dom/client")

const resolveAfterMs = Number(process.argv[2] ?? 3000)

let renders = 0
const data = new Promise((resolve) => setTimeout(() => resolve("loaded"), resolveAfterMs))
data.then((value) => Object.assign(data, { status: "fulfilled", value }))

function Data() {
  renders++
  if (data.status !== "fulfilled") throw data
  return data.value
}

function UpdatesOnMount() {
  const [, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return h(Suspense, { fallback: "loading A" }, h(Data))
}

function App() {
  return h("div", null, h(UpdatesOnMount), h(Suspense, { fallback: "loading B" }, h(Data)))
}

const container = document.getElementById("root")
createRoot(container).render(h(App))

const t0 = Date.now()
let last = 0
const interval = setInterval(() => {
  console.log(`t=${Date.now() - t0}ms renders/s=${(renders - last) * 2} dom=${container.textContent}`)
  last = renders
  if (Date.now() - t0 > resolveAfterMs + 1000) {
    clearInterval(interval)
    process.exit(0)
  }
}, 500)
