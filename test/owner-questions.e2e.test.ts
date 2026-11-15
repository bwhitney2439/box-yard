import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import type { Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { createBoxYard, type BoxYard } from "../server/app.js"
import { askKey } from "../shared/askQuestions.js"
import { BACKUP_SWEEP_MS, BACKUP_WAIT_MS, PLAIN_KEY, type OwnerQuestion } from "../shared/ownerQuestions.js"
import type { CaptainMessage, ChatMessage, Project, UiEvent } from "../shared/types.js"
import { freePort, testConfig, waitFor } from "./helpers.js"

// Inbox questions end to end (docs/specs/inbox-owner-questions.md), on a real server with the fake Claude as the
// Captain and the Coordinator: a Captain's marked reply wakes the Coordinator, which files it with ask_owner over its
// own MCP endpoint (FAKE_CLAUDE_ASK_OWNER); Cody answers or dismisses it over the REST routes; the answer reaches the
// Coordinator and, passed on, the Captain. Then the backup, dismiss, and a status-only project.

const QUESTION = "Which database should the spike use?"
const DEBOUNCE_MS = 300

interface Running {
  yard: BoxYard
  server: Server
  base: string
  events: UiEvent[]
}
const running: Running[] = []

async function start(): Promise<Running> {
  const port = await freePort()
  const yard = createBoxYard(testConfig({ port, orchestratorAutoWake: true }), { webDir: "/nonexistent" })
  yard.orchestrator.tuning.wakeDebounceMs = DEBOUNCE_MS
  // Every event the server broadcasts to the browser's stream.
  const events: UiEvent[] = []
  const broadcast = yard.hub.broadcast.bind(yard.hub)
  yard.hub.broadcast = (event: UiEvent) => {
    events.push(event)
    broadcast(event)
  }
  const server = await new Promise<Server>((resolve) => {
    const s = yard.app.listen(port, "127.0.0.1", () => resolve(s))
  })
  await yard.start()
  const r: Running = { yard, server, base: `http://127.0.0.1:${port}`, events }
  running.push(r)
  return r
}

afterEach(async () => {
  vi.useRealTimers()
  delete process.env.FAKE_CLAUDE_ASK_OWNER
  for (const r of running.splice(0)) {
    r.yard.stop()
    await new Promise((res) => r.server.close(() => res(null)))
  }
})

async function send(r: Running, method: string, url: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(r.base + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json() }
}

async function call<T>(r: Running, method: string, url: string, body?: unknown): Promise<T> {
  const { status, data } = await send(r, method, url, body)
  if (status >= 400) throw new Error(`${method} ${url} -> ${status}: ${JSON.stringify(data)}`)
  return data as T
}

/** Every prompt the Coordinator's fake Claude session received. */
function coordinatorPrompts(r: Running): string[] {
  const id = r.yard.store.getKv("orchestrator_session")
  if (!id) return []
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".fake-claude"), "fake-sessions", `${id}.json`)
  if (!fs.existsSync(file)) return []
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { turns: { prompt: string }[] }).turns.map((t) => t.prompt)
}

const chat = (r: Running) => r.yard.store.listChat(500)
const captainReports = (r: Running, p: Project) => chat(r).filter((m: ChatMessage) => m.role === "notice" && m.meta?.captain === true && m.meta?.projectId === p.id)
const inboxNotices = (r: Running, p: Project) => chat(r).filter((m: ChatMessage) => m.role === "notice" && m.meta?.projectId === p.id && typeof m.meta?.ownerQuestion === "string")
const captainMessages = (r: Running, p: Project) => call<CaptainMessage[]>(r, "GET", `/api/projects/${p.id}/captain/messages`)
const captainIdle = (r: Running, p: Project) =>
  waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", `/api/projects/${p.id}/captain`)).busy, "Captain idle", 30_000)
const coordinatorIdle = (r: Running) => waitFor(async () => !(await call<{ busy: boolean }>(r, "GET", "/api/orchestrator")).busy, "Coordinator idle", 30_000)
const coordinatorTurns = (r: Running) => r.yard.store.listTurnTimings({ since: 0, limit: 1000 }).filter((t) => t.role === "coordinator")
const wakeTurns = (r: Running) => coordinatorTurns(r).filter((t) => t.trigger === "updates")
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const openItems = (r: Running) => call<OwnerQuestion[]>(r, "GET", "/api/owner-questions")
const questionEvents = (r: Running, id: string) =>
  r.events.flatMap((e) => (e.type === "owner.question" && e.question.id === id ? [e.question] : []))
const notificationsFor = (r: Running, id: string) => r.yard.store.listNotifications(200).filter((n) => n.href === `/?ask=${id}`)
const rowOf = (r: Running, id: string) =>
  r.yard.db.prepare("SELECT state, filed_by, grouped_into FROM owner_questions WHERE id = ?").get(id) as { state: string; filed_by: string | null; grouped_into: string | null }
const rowsOf = (r: Running, p: Project) =>
  r.yard.db.prepare("SELECT id, state, filed_by, grouped_into FROM owner_questions WHERE project_id = ? ORDER BY created_at").all(p.id) as {
    id: string
    state: string
    filed_by: string | null
    grouped_into: string | null
  }[]

/** The Captain answers Cody's own message with a question for Cody (the owner-question line); resolves once it's up. */
async function captainAsks(r: Running, p: Project) {
  await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "Plan the spike [ask-owner]" })
  const report = await waitFor(() => captainReports(r, p)[0], "the Captain's report", 30_000)
  await captainIdle(r, p)
  return report
}

describe("Inbox questions end to end", () => {
  it("a marked Captain reply wakes the Coordinator, which files it with ask_owner; Cody's answer goes to it and on to the Captain", async () => {
    process.env.FAKE_CLAUDE_ASK_OWNER = "1"
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })

    // a. The Captain's marked reply reaches the Coordinator as a waking report (never an FYI), with a waiting row.
    const report = await captainAsks(r, p)
    expect(report.content).toContain(QUESTION)
    expect(report.content).not.toContain("boxyard-")
    expect(report.meta?.fyi).toBeUndefined()
    const [waiting] = rowsOf(r, p)
    expect(waiting).toMatchObject({ state: "waiting", filed_by: null })

    // b. The woken Coordinator calls ask_owner: an open Inbox item, the waiting row grouped into it, a notification
    // and an owner.question event for every tab.
    await waitFor(() => wakeTurns(r).length >= 1, "the Coordinator's wake", 10_000)
    const [item] = await waitFor(async () => {
      const open = await openItems(r)
      return open.length ? open : null
    }, "the Inbox item", 30_000)
    await coordinatorIdle(r)
    expect(coordinatorPrompts(r)[0]).toContain(QUESTION)
    expect(item).toMatchObject({
      projectId: p.id,
      state: "open",
      filedBy: "coordinator",
      intro: "The Captain for demo is planning the spike.",
      questions: [{ question: QUESTION, defaultAnswer: "Postgres", options: ["SQLite"] }],
    })
    expect(rowOf(r, waiting!.id)).toMatchObject({ state: "grouped", grouped_into: item!.id })
    expect(r.yard.ownerQuestions.waiting(p.id)).toBeNull()
    const [notification] = notificationsFor(r, item!.id)
    expect(notification).toMatchObject({ taskId: null, status: "needs_input", title: "Captain for demo asks", summary: QUESTION, readAt: null })
    expect(r.events.some((e) => e.type === "notification" && e.notification.id === notification!.id)).toBe(true)
    expect(questionEvents(r, item!.id).map((q) => q.state)).toEqual(["open"])

    // Answering with stale questions or a missing answer is refused, and the item stays open.
    expect((await send(r, "POST", `/api/owner-questions/${item!.id}/answers`, { key: "stale", answers: ["Postgres"] })).status).toBe(409)
    expect((await send(r, "POST", `/api/owner-questions/${item!.id}/answers`, { key: askKey(item!.questions!), answers: [""] })).status).toBe(400)
    expect(await openItems(r)).toHaveLength(1)

    // c. Cody answers: the item closes, its notification is read, and the Coordinator gets the answer as Cody's
    // message, with the question, the answer, the project and the Captain.
    const turnsBefore = coordinatorTurns(r).length
    const closed = await call<OwnerQuestion>(r, "POST", `/api/owner-questions/${item!.id}/answers`, {
      id: "msg_answer01",
      key: askKey(item!.questions!),
      answers: ["SQLite, it's a spike"],
    })
    expect(closed).toMatchObject({ id: item!.id, state: "answered" })
    expect(closed.closedAt).toEqual(expect.any(Number))
    expect(await openItems(r)).toEqual([])
    expect(notificationsFor(r, item!.id)[0]!.readAt).toEqual(expect.any(Number))
    expect(r.events.some((e) => e.type === "notifications.read" && e.ids.includes(notification!.id))).toBe(true)
    expect(questionEvents(r, item!.id).map((q) => q.state)).toEqual(["open", "answered"])
    // A double tap sends once; a different answer to a closed item is refused.
    expect((await send(r, "POST", `/api/owner-questions/${item!.id}/answers`, { id: "msg_answer01", key: askKey(item!.questions!), answers: ["SQLite, it's a spike"] })).status).toBe(200)
    expect((await send(r, "POST", `/api/owner-questions/${item!.id}/answers`, { id: "msg_answer02", key: askKey(item!.questions!), answers: ["Postgres"] })).status).toBe(409)

    const prompt = await waitFor(() => coordinatorPrompts(r).find((t) => t.includes(`[Inbox answer ${item!.id}`)), "the answer's Coordinator turn", 30_000)
    expect(prompt).toContain(`[Inbox answer ${item!.id} · Captain for "demo" (${p.id})]`)
    expect(prompt).toContain('answered the question you filed for the Captain for "demo". Pass it on with send_to_captain')
    expect(prompt).toContain(QUESTION)
    expect(prompt).toContain("SQLite, it's a spike")
    const asCody = chat(r).filter((m) => m.role === "user" && m.meta?.ownerQuestion === item!.id)
    expect(asCody).toHaveLength(1)
    await coordinatorIdle(r)
    expect(coordinatorTurns(r).length).toBeGreaterThan(turnsBefore)

    // The Coordinator passed it on: the Captain gets the answer from it.
    const passed = await waitFor(
      async () => (await captainMessages(r, p)).find((m) => m.role === "user" && m.content.includes(`Cody answered from the Inbox (${item!.id})`)),
      "the Captain gets the answer",
      30_000,
    )
    expect(passed.content).toContain("SQLite, it's a spike")
    expect(passed.meta?.source ?? "coordinator").toBe("coordinator")
    await captainIdle(r, p)
    // Nothing more was filed along the way.
    expect(rowsOf(r, p).map((row) => row.state)).toEqual(["grouped", "answered"])
  }, 90_000)

  it("the backup files a question nobody acted on after 5 minutes; Cody's answer goes straight to the Captain", async () => {
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await captainAsks(r, p)
    // The Coordinator is woken (not an FYI), and does nothing about it.
    await waitFor(() => wakeTurns(r).length >= 1, "the Coordinator's wake", 10_000)
    await coordinatorIdle(r)
    const [waiting] = rowsOf(r, p)
    expect(waiting).toMatchObject({ state: "waiting" })
    const promptsBefore = coordinatorPrompts(r).length
    const turnsBefore = coordinatorTurns(r).length

    // The backup's own minute-by-minute sweep, on fake time from here (only Date and the sweep's interval are faked).
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
    r.yard.ownerQuestions.stop()
    r.yard.ownerQuestions.start()
    vi.advanceTimersByTime(BACKUP_WAIT_MS - BACKUP_SWEEP_MS)
    expect(rowOf(r, waiting!.id).state).toBe("waiting")
    expect(await openItems(r)).toEqual([])
    vi.advanceTimersByTime(2 * BACKUP_SWEEP_MS)
    vi.useRealTimers()

    // d. Filed by Box Yard, as the Captain's own words, with a notification and a quiet notice to the Coordinator.
    const [item] = await openItems(r)
    expect(item).toMatchObject({ id: waiting!.id, filedBy: "backup", questions: null, intro: null })
    expect(item!.text).toContain(QUESTION)
    expect(item!.text).not.toContain("boxyard-")
    expect(notificationsFor(r, item!.id)).toHaveLength(1)
    expect(questionEvents(r, item!.id).map((q) => q.state)).toEqual(["open"])
    const notice = (verb: string) => inboxNotices(r, p).find((m) => m.content.startsWith(`📥 **Inbox** ${verb}:`))
    const filedNotice = notice("filed")
    expect(filedNotice!.content).toMatch(/^📥 \*\*Inbox\*\* filed: the Captain for demo's question waited 5 minutes/)
    expect(filedNotice!.meta?.fyi).toBe(true)

    // Cody answers it: straight to the Captain, quoting its question; the Coordinator gets a quiet notice, no turn.
    const closed = await call<OwnerQuestion>(r, "POST", `/api/owner-questions/${item!.id}/answers`, { key: PLAIN_KEY, answers: ["SQLite is fine."] })
    expect(closed.state).toBe("answered")
    const toCaptain = await waitFor(
      async () => (await captainMessages(r, p)).find((m) => m.role === "user" && m.content.startsWith(`[Inbox answer ${item!.id}`)),
      "the answer on the Captain's chat",
      10_000,
    )
    expect(toCaptain.content).toContain("answered your question from")
    expect(toCaptain.content).toContain(`> `)
    expect(toCaptain.content).toContain(QUESTION)
    expect(toCaptain.content).toMatch(/My answer:\n\nSQLite is fine\.$/)
    const answeredNotice = notice("answered")
    expect(answeredNotice!.content).toMatch(/^📥 \*\*Inbox\*\* answered: .* answered the Captain for demo's question; it went to the Captain\.$/)
    expect(answeredNotice!.meta?.fyi).toBe(true)
    await captainIdle(r, p)
    await sleep(DEBOUNCE_MS + 700)
    await coordinatorIdle(r)
    expect(coordinatorPrompts(r)).toHaveLength(promptsBefore)
    expect(coordinatorTurns(r)).toHaveLength(turnsBefore)
    expect(chat(r).filter((m) => m.role === "user" && m.meta?.ownerQuestion === item!.id)).toEqual([])
  }, 90_000)

  it("dismissing tells the Coordinator and the Captain quietly, and starts no turn", async () => {
    process.env.FAKE_CLAUDE_ASK_OWNER = "1"
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "demo" })
    await captainAsks(r, p)
    const [item] = await waitFor(async () => {
      const open = await openItems(r)
      return open.length ? open : null
    }, "the Inbox item", 30_000)
    await coordinatorIdle(r)
    const coordinatorBefore = coordinatorTurns(r).length
    const captainBefore = (await captainMessages(r, p)).filter((m) => m.role === "assistant").length

    // e. Dismissed: closed, notification read, a quiet notice on both sides.
    const closed = await call<OwnerQuestion>(r, "POST", `/api/owner-questions/${item!.id}/dismiss`, {})
    expect(closed.state).toBe("dismissed")
    expect(await openItems(r)).toEqual([])
    expect(notificationsFor(r, item!.id)[0]!.readAt).toEqual(expect.any(Number))
    expect(questionEvents(r, item!.id).map((q) => q.state)).toEqual(["open", "dismissed"])
    const [coordinatorNotice] = inboxNotices(r, p)
    expect(coordinatorNotice!.content).toMatch(new RegExp(`^📥 \\*\\*Inbox\\*\\* dismissed: .* dismissed the Captain for demo's question: ${QUESTION.replace("?", "\\?")}$`))
    expect(coordinatorNotice!.meta?.fyi).toBe(true)
    const captainNotice = (await captainMessages(r, p)).find((m) => m.role === "notice" && m.meta?.ownerQuestion === item!.id)
    expect(captainNotice!.content).toMatch(new RegExp(`^📥 \\*\\*Inbox\\*\\* dismissed: .* dismissed your question: ${QUESTION.replace("?", "\\?")}$`))
    // Answering or dismissing again is refused.
    expect((await send(r, "POST", `/api/owner-questions/${item!.id}/dismiss`, {})).status).toBe(409)
    expect((await send(r, "POST", `/api/owner-questions/${item!.id}/answers`, { key: askKey(item!.questions!), answers: ["Postgres"] })).status).toBe(409)
    expect((await send(r, "POST", "/api/owner-questions/oq_nope12345678/dismiss", {})).status).toBe(404)

    await sleep(DEBOUNCE_MS + 1000)
    await coordinatorIdle(r)
    await captainIdle(r, p)
    expect(coordinatorTurns(r)).toHaveLength(coordinatorBefore)
    expect((await captainMessages(r, p)).filter((m) => m.role === "assistant")).toHaveLength(captainBefore)
  }, 90_000)

  it("a status-only project's question is filed at once, the Coordinator sees none of it, and the answer goes straight to the Captain", async () => {
    process.env.FAKE_CLAUDE_ASK_OWNER = "1"
    const r = await start()
    const p = await call<Project>(r, "POST", "/api/projects", { name: "secret" })
    r.yard.identities.assign(p.id, r.yard.identities.create({ name: "Private", coordinatorSees: "status" }).id)
    await call(r, "POST", `/api/projects/${p.id}/captain/messages`, { content: "Plan the spike [ask-owner]" })

    // f. Filed by the Captain itself, at once: no waiting row, no report, no Coordinator turn.
    const [item] = await waitFor(async () => {
      const open = await openItems(r)
      return open.length ? open : null
    }, "the Inbox item", 30_000)
    expect(item).toMatchObject({ projectId: p.id, filedBy: "captain", questions: null })
    expect(item!.text).toContain(QUESTION)
    expect(notificationsFor(r, item!.id)).toHaveLength(1)
    await captainIdle(r, p)
    await sleep(DEBOUNCE_MS + 700)
    await coordinatorIdle(r)
    expect(rowsOf(r, p).map((row) => row.state)).toEqual(["open"])
    expect(captainReports(r, p)).toEqual([])
    expect(coordinatorTurns(r)).toEqual([])

    // Answered: straight to the Captain, and the Coordinator still sees nothing of it.
    await call(r, "POST", `/api/owner-questions/${item!.id}/answers`, { key: PLAIN_KEY, answers: ["Use SQLite."] })
    const toCaptain = await waitFor(
      async () => (await captainMessages(r, p)).find((m) => m.role === "user" && m.content.startsWith(`[Inbox answer ${item!.id}`)),
      "the answer on the Captain's chat",
      10_000,
    )
    expect(toCaptain.content).toContain(QUESTION)
    expect(toCaptain.content).toContain("Use SQLite.")
    await captainIdle(r, p)
    await sleep(DEBOUNCE_MS + 700)
    await coordinatorIdle(r)
    expect(coordinatorTurns(r)).toEqual([])
    const seen = chat(r).map((m) => m.content).join("\n")
    expect(seen).not.toContain(QUESTION)
    expect(seen).not.toContain("Use SQLite.")
    expect(seen).not.toContain(item!.id)
  }, 90_000)
})
