// Node globals the NEAR wallet-selector / near-js packages expect in the browser.
import { Buffer } from "buffer"

const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: { env: Record<string, string | undefined> } }
g.Buffer ??= Buffer
g.process ??= { env: {} }
g.process.env ??= {}
