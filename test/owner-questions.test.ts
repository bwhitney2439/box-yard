import { afterEach, describe, expect, it } from "vitest"
import express, { type NextFunction, type Request, type Response } from "express"
import type { Server } from "node:http"
import type { AddressInfo } from "node:net"
import Database from "better-sqlite3"
import { migrate, MIGRATIONS, openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { OwnerQuestions, type OwnerQuestionsDeps } from "../server/ownerQuestions.js"
import { ownerQuestionRoutes } from "../server/ownerQuestionsRoutes.js"
import { askKey } from "../shared/askQuestions.js"
import { BACKUP_BUSY_HOLD_MS, BACKUP_WAIT_MS, MAX_OPEN_PER_PROJECT, PLAIN_KEY } from "../shared/ownerQuestions.js"
import type { UiEvent } from "../shared/types.js"
import { tmpDir } from "./helpers.js"

const QS = [
  { question: "Which database should the spike use?", default_answer: "Postgres", options: ["SQLite"] },
  { question: "Keep the old API for a release?", default_answer: "Yes", options: ["No"] },
]

function setup(opts: { statusOnly?: boolean; dir?: string } = {}) {
  const dir = opts.dir ?? tmpDir()
  const db = openDb(dir)
  const store = new Store(db)
  if (!store.getProject("prj_demo01")) store.createProject({ id: "prj_demo01", name: "demo" })
  const events: UiEvent[] = []
  const toCoordinator: { content: string; meta: Record<string, unknown> }[] = []
  const toCaptain: { projectId: string; content: string; id?: string }[] = []
  const captainNotices: { projectId: string; content: string }[] = []
  const clock = { now: 1_000_000, busy: false, statusOnly: opts.statusOnly ?? false }
  const deps: OwnerQuestionsDeps = {
    db,
    store,
    hub: { broadcast: (e) => void events.push(e) },
    ownerName: () => "Mutley",
    statusOnly: () => clock.statusOnly,
    coordinatorBusy: () => clock.busy,
    messageCoordinator: (content, meta) => void toCoordinator.push({ content, meta }),
    messageCaptain: (projectId, content, id) => void toCaptain.push({ projectId, content, id }),
    captainNotice: (projectId, content) => void captainNotices.push({ projectId, content }),
    now: () => clock.now,
  }
  const oq = new OwnerQuestions(deps)
  const chat = () => store.listChat().filter((m) => m.role === "notice")
  return { dir, db, store, oq, events, toCoordinator, toCaptain, captainNotices, clock, chat }
}

const states = (db: Database.Database) => (db.prepare("SELECT state FROM owner_questions ORDER BY created_at, rowid").all() as { state: string }[]).map((r) => r.state)

describe("owner_questions migration", () => {
  it("adds the table to a database from before it, with its index", () => {
    const db = new Database(":memory:")
    db.pragma("foreign_keys = ON")
    const at = MIGRATIONS.findIndex((m) => m.includes("owner_questions"))
    expect(at).toBeGreaterThan(0)
    migrate(db, at)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'owner_questions'").get()).toBeUndefined()
    migrate(db)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'owner_questions'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'owner_questions_open'").get()).toBeTruthy()
  })
})

describe("OwnerQuestions.file (ask_owner)", () => {
  it("files an open item with cleaned questions, a notification and an event", () => {
    const { oq, events } = setup()
    const { question, duplicate, grouped } = oq.file({ projectId: "prj_demo01", question: "  Two calls for the spike  ", questions: QS })
    expect(duplicate).toBe(false)
    expect(grouped).toBe(0)
    expect(question).toMatchObject({ projectId: "prj_demo01", state: "open", filedBy: "coordinator", intro: "Two calls for the spike", closedAt: null })
    expect(question.id).toMatch(/^oq_[a-f0-9]{12}$/)
    expect(question.questions).toEqual([
      { question: "Which database should the spike use?", defaultAnswer: "Postgres", options: ["SQLite"] },
      { question: "Keep the old API for a release?", defaultAnswer: "Yes", options: ["No"] },
    ])
    expect(question.text).toContain("1. Which database should the spike use? (default: Postgres; or: SQLite)")
    expect(oq.listOpen()).toEqual([question])
    expect(events).toContainEqual({ type: "owner.question", question })
  })

  it("adds a task-less needs_input notification that opens the item", () => {
    const { oq, store } = setup()
    const { question } = oq.file({ projectId: "prj_demo01", questions: QS })
    const [n] = store.listNotifications()
    expect(n).toMatchObject({ taskId: null, status: "needs_input", title: "Captain for demo asks", summary: "Which database should the spike use?", href: `/?ask=${question.id}`, projectId: "prj_demo01", projectName: "demo", readAt: null })
    expect(n!.boxId).toBeUndefined()
  })

  it("returns the open item for a retry with the same questions", () => {
    const { oq, store } = setup()
    const first = oq.file({ projectId: "prj_demo01", questions: QS })
    const again = oq.file({ projectId: "prj_demo01", question: "different intro", questions: QS })
    expect(again).toEqual({ question: first.question, duplicate: true, grouped: 0 })
    expect(oq.listOpen()).toHaveLength(1)
    expect(store.listNotifications()).toHaveLength(1)
  })

  it("refuses bad questions, an unknown project and an 11th open item", () => {
    const { oq } = setup()
    expect(() => oq.file({ projectId: "prj_nope01", questions: QS })).toThrow(/No project/)
    expect(() => oq.file({ projectId: "prj_demo01", questions: [] })).toThrow(/non-empty/)
    expect(() => oq.file({ projectId: "prj_demo01", questions: [{ question: "Why?" }] })).toThrow(/default_answer is required/)
    for (let i = 0; i < MAX_OPEN_PER_PROJECT; i++) oq.file({ projectId: "prj_demo01", questions: [{ question: `Q${i}?`, default_answer: "yes" }] })
    expect(() => oq.file({ projectId: "prj_demo01", questions: [{ question: "One more?", default_answer: "yes" }] })).toThrow("Mutley already has 10 open questions for this project. Group them, or wait for answers.")
    // A retry of one already open still gets it back.
    expect(oq.file({ projectId: "prj_demo01", questions: [{ question: "Q3?", default_answer: "yes" }] }).duplicate).toBe(true)
  })
})

describe("a Captain's question waiting for the Coordinator", () => {
  it("is one waiting row per project; a second joins it and keeps its clock", () => {
    const { oq, db, clock } = setup()
    oq.captainAsked("prj_demo01", "Which region? Mutley should decide.", "cap_1")
    const first = oq.waiting("prj_demo01")!
    expect(first.dueAt).toBe(clock.now + BACKUP_WAIT_MS)
    clock.now += 60_000
    oq.captainAsked("prj_demo01", "Also: which plan?", "cap_2")
    const second = oq.waiting("prj_demo01")!
    expect(second.id).toBe(first.id)
    expect(second.dueAt).toBe(first.dueAt)
    expect(second.text).toBe("Which region? Mutley should decide.\n\nAlso: which plan?")
    expect(states(db)).toEqual(["waiting"])
    expect(oq.listOpen()).toEqual([])
  })

  it("is grouped into an ask_owner item for the project, so the backup never files it", () => {
    const { oq, db, clock } = setup()
    oq.captainAsked("prj_demo01", "Which region?")
    const { question, grouped } = oq.file({ projectId: "prj_demo01", questions: QS })
    expect(grouped).toBe(1)
    expect(db.prepare("SELECT state, grouped_into FROM owner_questions WHERE state != 'open'").get()).toEqual({ state: "grouped", grouped_into: question.id })
    clock.now += BACKUP_WAIT_MS * 2
    expect(oq.sweep()).toEqual([])
  })

  it("is handled when the Coordinator messages that Captain itself", () => {
    const { oq, db, clock } = setup()
    oq.captainAsked("prj_demo01", "Which region?")
    expect(oq.coordinatorReplied("prj_demo01")).toBe(1)
    expect(states(db)).toEqual(["handled"])
    clock.now += BACKUP_WAIT_MS * 2
    expect(oq.sweep()).toEqual([])
    expect(oq.coordinatorReplied("prj_demo01")).toBe(0)
  })

  it("goes to the Inbox at once in a status-only project, and the Coordinator hears nothing", () => {
    const { oq, chat } = setup({ statusOnly: true })
    oq.captainAsked("prj_demo01", "Which region?", "cap_1")
    expect(oq.waiting("prj_demo01")).toBeNull()
    expect(oq.listOpen()).toMatchObject([{ state: "open", filedBy: "captain", questions: null, text: "Which region?" }])
    expect(chat()).toEqual([])
  })
})

describe("the backup sweep", () => {
  it("files a question 5 minutes after it was asked, as the Captain's words, with a quiet Coordinator notice", () => {
    const { oq, clock, chat, events, store } = setup()
    oq.captainAsked("prj_demo01", "Which region?")
    clock.now += BACKUP_WAIT_MS - 1
    expect(oq.sweep()).toEqual([])
    clock.now += 1
    const [id] = oq.sweep()
    expect(oq.get(id!)).toMatchObject({ state: "open", filedBy: "backup", questions: null, text: "Which region?" })
    expect(events.some((e) => e.type === "owner.question" && e.question.id === id)).toBe(true)
    expect(store.listNotifications()[0]).toMatchObject({ href: `/?ask=${id}`, status: "needs_input" })
    const [notice] = chat()
    expect(notice!.content).toBe("📥 **Inbox** filed: the Captain for demo's question waited 5 minutes with no Inbox item, so Box Yard put it in the Inbox.")
    expect(notice!.meta).toMatchObject({ fyi: true, projectId: "prj_demo01", ownerQuestion: id })
    expect(oq.sweep()).toEqual([])
  })

  it("holds while the Coordinator is mid-turn, but not past 30 minutes", () => {
    const { oq, clock } = setup()
    oq.captainAsked("prj_demo01", "Which region?")
    clock.busy = true
    clock.now += BACKUP_WAIT_MS
    expect(oq.sweep()).toEqual([])
    clock.now += BACKUP_BUSY_HOLD_MS - BACKUP_WAIT_MS - 1
    expect(oq.sweep()).toEqual([])
    clock.now += 1
    expect(oq.sweep()).toHaveLength(1)
  })

  it("survives a restart: start() sweeps at once", () => {
    const first = setup()
    first.oq.captainAsked("prj_demo01", "Which region?")
    first.db.close()
    const again = setup({ dir: first.dir })
    again.clock.now = first.clock.now + BACKUP_WAIT_MS
    again.oq.start()
    again.oq.stop()
    expect(again.oq.listOpen()).toMatchObject([{ filedBy: "backup", text: "Which region?" }])
  })
})

describe("answering and dismissing", () => {
  it("refuses a changed key (409), bad answers (400), and a closed item (409)", () => {
    const { oq } = setup()
    const { question } = oq.file({ projectId: "prj_demo01", questions: QS })
    const key = askKey(question.questions!)
    expect(() => oq.answer(question.id, "nope", ["Postgres", "Yes"])).toThrow(expect.objectContaining({ status: 409, message: "These questions changed" }))
    expect(() => oq.answer(question.id, key, ["Postgres"])).toThrow(expect.objectContaining({ status: 400, message: "Expected 2 answers" }))
    expect(() => oq.answer(question.id, key, ["Postgres", " "])).toThrow(expect.objectContaining({ status: 400 }))
    oq.answer(question.id, key, ["Postgres", "Yes"])
    expect(() => oq.answer(question.id, key, ["Postgres", "Yes"])).toThrow(expect.objectContaining({ status: 409, message: "Already answered" }))
    expect(() => oq.dismiss(question.id)).toThrow(expect.objectContaining({ status: 409, message: "Already answered" }))
    expect(() => oq.answer("oq_000000000000", key, ["x"])).toThrow(expect.objectContaining({ status: 404 }))
  })

  it("gives a resend with the same client message id the closed item back, and sends once", () => {
    const { oq, toCoordinator } = setup()
    const { question } = oq.file({ projectId: "prj_demo01", questions: QS })
    const key = askKey(question.questions!)
    const first = oq.answer(question.id, key, ["Postgres", "Yes"], "msg_abcdef12")
    expect(oq.answer(question.id, key, ["Postgres", "Yes"], "msg_abcdef12")).toEqual(first)
    expect(() => oq.answer(question.id, key, ["Postgres", "Yes"], "msg_other123")).toThrow("Already answered")
    expect(toCoordinator).toHaveLength(1)
  })

  it("answers a plain item with one answer under the plain key", () => {
    const { oq, clock, toCaptain } = setup()
    oq.captainAsked("prj_demo01", "Which region?")
    clock.now += BACKUP_WAIT_MS
    const [id] = oq.sweep()
    expect(() => oq.answer(id!, PLAIN_KEY, ["a", "b"])).toThrow("Expected 1 answer")
    expect(() => oq.answer(id!, askKey([]), ["eu"])).toThrow("These questions changed")
    expect(oq.answer(id!, PLAIN_KEY, ["eu-west"])).toMatchObject({ state: "answered" })
    expect(toCaptain).toHaveLength(1)
  })

  it("closes the item's notification and tells every tab it's gone", () => {
    const { oq, store, events } = setup()
    const { question } = oq.file({ projectId: "prj_demo01", questions: QS })
    const closed = oq.dismiss(question.id)
    expect(closed).toMatchObject({ state: "dismissed", closedAt: expect.any(Number) })
    expect(store.listNotifications()[0]!.readAt).not.toBeNull()
    expect(events).toContainEqual(expect.objectContaining({ type: "notifications.read" }))
    expect(events.at(-1)).toEqual({ type: "owner.question", question: closed })
    expect(oq.listOpen()).toEqual([])
    expect(() => oq.dismiss(question.id)).toThrow("Already dismissed")
    expect(() => oq.answer(question.id, askKey(question.questions!), ["Postgres", "Yes"])).toThrow("Already dismissed")
  })

  it("keeps the item open when the answer can't be sent", () => {
    const s = setup()
    const oq = new OwnerQuestions({
      db: s.db,
      store: s.store,
      hub: { broadcast: () => {} },
      ownerName: () => "Mutley",
      statusOnly: () => false,
      coordinatorBusy: () => false,
      messageCoordinator: () => {
        throw new Error("down")
      },
      messageCaptain: () => {},
      captainNotice: () => {},
    })
    const { question } = oq.file({ projectId: "prj_demo01", questions: QS })
    expect(() => oq.answer(question.id, askKey(question.questions!), ["Postgres", "Yes"])).toThrow("down")
    expect(oq.get(question.id)!.state).toBe("open")
  })

  it("deletes a project's questions with it", () => {
    const { oq, store, db } = setup()
    oq.file({ projectId: "prj_demo01", questions: QS })
    oq.captainAsked("prj_demo01", "Which region?")
    store.deleteProject("prj_demo01")
    expect(states(db)).toEqual([])
  })
})

describe("the routes", () => {
  const servers: Server[] = []
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  })

  async function start() {
    const s = setup()
    const api = express.Router()
    ownerQuestionRoutes(api, s.oq)
    const app = express()
    app.use(express.json())
    app.use("/api", api)
    app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => void res.status(err.status ?? 500).json({ error: err.message }))
    const server = await new Promise<Server>((resolve) => {
      const x = app.listen(0, "127.0.0.1", () => resolve(x))
    })
    servers.push(server)
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/owner-questions`
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    return { ...s, base, post }
  }

  it("lists open items newest first, answers, dismisses, and maps errors to 400/404/409", async () => {
    const { oq, base, post, clock } = await start()
    const a = oq.file({ projectId: "prj_demo01", questions: QS }).question
    clock.now += 1
    const b = oq.file({ projectId: "prj_demo01", questions: [{ question: "Ship it?", default_answer: "Yes" }] }).question
    expect((await (await fetch(base)).json()).map((q: { id: string }) => q.id)).toEqual([b.id, a.id])

    const key = askKey(a.questions!)
    expect((await post(`/${a.id}/answers`, { key, answers: "Postgres" })).status).toBe(400)
    expect((await post(`/${a.id}/answers`, { key, answers: ["Postgres"] })).status).toBe(400)
    expect((await post(`/${a.id}/answers`, { key: "stale", answers: ["Postgres", "Yes"] })).status).toBe(409)
    expect((await post(`/oq_000000000000/answers`, { key, answers: ["x"] })).status).toBe(404)
    const ok = await post(`/${a.id}/answers`, { id: "msg_abcdef12", key, answers: ["Postgres", "Yes"] })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ id: a.id, state: "answered" })
    expect((await post(`/${a.id}/answers`, { id: "msg_abcdef12", key, answers: ["Postgres", "Yes"] })).status).toBe(200)
    const again = await post(`/${a.id}/answers`, { id: "msg_zzzzzz12", key, answers: ["Postgres", "Yes"] })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: "Already answered" })

    const dismissed = await post(`/${b.id}/dismiss`, {})
    expect(await dismissed.json()).toMatchObject({ id: b.id, state: "dismissed" })
    expect((await post(`/${b.id}/dismiss`, {})).status).toBe(409)
    expect((await post(`/oq_000000000000/dismiss`, {})).status).toBe(404)
    expect(await (await fetch(base)).json()).toEqual([])
  })
})
