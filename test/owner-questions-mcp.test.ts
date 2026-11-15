import { afterEach, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { ALWAYS_LOAD, CORE_TOOLS, buildMcpServer, type McpCaller, type McpDeps } from "../server/mcp.js"
import { OwnerQuestions } from "../server/ownerQuestions.js"
import { THREAD_TOOLS } from "../server/sideThreads.js"
import { MAX_OPEN_PER_PROJECT } from "../shared/ownerQuestions.js"
import { tmpDir } from "./helpers.js"

// The Coordinator's ask_owner tool and its hooks in server/mcp.ts (docs/specs/inbox-owner-questions.md §6).

const QS = [
  { question: "Which database should the spike use?", default_answer: "Postgres", options: ["SQLite", "postgres"] },
  { question: "Keep the old API for a release?", default_answer: "Yes", options: ["No"] },
]

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function setup() {
  const store = new Store(openDb(tmpDir()))
  const open = store.createProject({ name: "open" })
  const secret = store.createProject({ name: "secret" })
  const sealed = new Set([secret.id])
  const oq = new OwnerQuestions({
    db: store.db,
    store,
    hub: { broadcast: () => {} },
    ownerName: () => "Mutley",
    statusOnly: (id) => sealed.has(id),
    coordinatorBusy: () => false,
    messageCoordinator: () => {},
    messageCaptain: () => {},
    captainNotice: () => {},
  })
  const sent: { tool: string; projectId: string }[] = []
  const captains = {
    send: (ref: string, _content: string, opts: { tool?: string }) => {
      const projectId = store.findProject(ref)!.id
      sent.push({ tool: opts.tool ?? "", projectId })
      return { id: "cm_1", projectId }
    },
    state: () => "idle",
    ask: async (ref: string) => {
      sent.push({ tool: "ask_captain", projectId: store.findProject(ref)!.id })
      return { reply: "Done." }
    },
  }
  const deps = {
    store,
    hub: { broadcast: () => {} },
    tasks: { prs: { ensureFresh: async () => {} }, resizeMode: () => "replace" },
    settings: { get: () => ({ ownerName: "Mutley" }) },
    identities: { statusOnly: (id: string) => sealed.has(id) },
    captains,
    ownerQuestions: oq,
  } as unknown as McpDeps
  const connect = async (caller: McpCaller = { kind: "coordinator" }, d: McpDeps = deps) => {
    const server = buildMcpServer(d, caller)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: "owner-questions-mcp-test", version: "0" })
    await client.connect(b)
    cleanups.push(async () => {
      await client.close()
      await server.close()
    })
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
      const text = res.content.map((c) => c.text).join("\n")
      return { error: Boolean(res.isError), text, json: () => JSON.parse(text) }
    }
    return { client, call }
  }
  const states = () => (store.db.prepare("SELECT state FROM owner_questions ORDER BY created_at, rowid").all() as { state: string }[]).map((r) => r.state)
  return { store, oq, open, secret, sent, deps, connect, states }
}

describe("ask_owner: who has it", () => {
  it("is listed for the Coordinator, always loaded, and named for the owner", async () => {
    const { connect } = setup()
    const { client } = await connect()
    const tool = (await client.listTools()).tools.find((t) => t.name === "ask_owner")
    expect(tool).toBeTruthy()
    expect(tool!._meta?.[ALWAYS_LOAD]).toBe(true)
    expect(tool!.description).toContain("in Mutley's Inbox")
    expect(JSON.stringify(tool)).not.toMatch(/\bCody\b/)
    expect(Object.keys((tool!.inputSchema as { properties: object }).properties).sort()).toEqual(["project", "question", "questions"])
  })

  it("is not listed for a Captain", async () => {
    const { connect, open } = setup()
    const { client, call } = await connect({ kind: "captain", projectId: open.id })
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("ask_owner")
    expect((await call("ask_owner", { project: open.id, questions: QS })).error).toBe(true)
  })

  it("is a Coordinator core tool, and not a side thread's: it writes", async () => {
    expect(CORE_TOOLS.coordinator.has("ask_owner")).toBe(true)
    expect(CORE_TOOLS.captain.has("ask_owner")).toBe(false)
    expect(THREAD_TOOLS.has("ask_owner")).toBe(false)
    const { connect, open, oq } = setup()
    const { call } = await connect({ kind: "coordinator", readOnly: true })
    expect((await call("ask_owner", { project: open.id, questions: QS })).error).toBe(true)
    expect(oq.listOpen()).toEqual([])
  })
})

describe("ask_owner: filing", () => {
  it("files the questions, cleaned, and says what's next", async () => {
    const { connect, open, oq } = setup()
    const { call } = await connect()
    const res = await call("ask_owner", { project: "open", question: " Two calls for the spike ", questions: QS })
    expect(res.error).toBe(false)
    const out = res.json()
    const [item] = oq.listOpen(open.id)
    expect(out).toEqual({
      filed: item!.id,
      project: "open",
      questions: 2,
      groupedCaptainQuestions: 0,
      duplicate: false,
      next: `It's in Mutley's Inbox. Tell Mutley in one line; don't ask the same thing in your reply. The answer comes to you as a message starting [Inbox answer ${item!.id}].`,
    })
    expect(item).toMatchObject({ filedBy: "coordinator", intro: "Two calls for the spike" })
    // The option that repeats the default is dropped.
    expect(item!.questions![0]).toEqual({ question: "Which database should the spike use?", defaultAnswer: "Postgres", options: ["SQLite"] })
  })

  it("takes over the Captain's waiting question", async () => {
    const { connect, open, oq, states } = setup()
    oq.captainAsked(open.id, "Postgres or SQLite for the spike?")
    const { call } = await connect()
    const out = (await call("ask_owner", { project: open.id, questions: QS })).json()
    expect(out.groupedCaptainQuestions).toBe(1)
    expect(oq.waiting(open.id)).toBeNull()
    expect(states()).toEqual(["grouped", "open"])
  })

  it("returns the open item for a retry with the same questions", async () => {
    const { connect, open, oq } = setup()
    const { call } = await connect()
    const first = (await call("ask_owner", { project: open.id, questions: QS })).json()
    const again = (await call("ask_owner", { project: "open", question: "Asked again", questions: QS })).json()
    expect(again).toMatchObject({ filed: first.filed, duplicate: true, groupedCaptainQuestions: 0, questions: 2 })
    expect(oq.listOpen()).toHaveLength(1)
  })
})

describe("ask_owner: each check, in order", () => {
  const ask = async (args: Record<string, unknown>) => {
    const s = setup()
    const { call } = await s.connect()
    return { ...s, res: await call("ask_owner", args) }
  }

  it("an unknown project", async () => {
    const { res } = await ask({ project: "nope", questions: QS })
    expect(res).toMatchObject({ error: true, text: 'No project "nope". Use list_projects.' })
  })

  it("an unknown project comes before bad questions", async () => {
    const { res } = await ask({ project: "nope", questions: [{ question: " ", default_answer: "" }] })
    expect(res.text).toBe('No project "nope". Use list_projects.')
  })

  it("a status-only project: its Captain files its own questions", async () => {
    const { res, oq } = await ask({ project: "secret", questions: QS })
    expect(res.error).toBe(true)
    expect(res.text).toMatch(/^Status only: its Captain puts its questions in Mutley's Inbox itself/)
    expect(oq.listOpen()).toEqual([])
  })

  it("a blank question", async () => {
    const { res } = await ask({ project: "open", questions: [{ question: "  ", default_answer: "Yes" }] })
    expect(res).toMatchObject({ error: true, text: "questions[0].question is required" })
  })

  it("a question with no default", async () => {
    const { res } = await ask({ project: "open", questions: [QS[0], { question: "Ship it?", default_answer: " " }] })
    expect(res).toMatchObject({ error: true, text: "questions[1].default_answer is required: your recommended answer, pre-selected" })
  })

  it("no questions, or too many options (the schema)", async () => {
    expect((await ask({ project: "open", questions: [] })).res.error).toBe(true)
    const options = Array.from({ length: 8 }, (_, i) => `Option ${i}`)
    expect((await ask({ project: "open", questions: [{ question: "Which?", default_answer: "A", options }] })).res.error).toBe(true)
  })

  it(`more than ${MAX_OPEN_PER_PROJECT} open items for the project`, async () => {
    const { connect, open, oq } = setup()
    for (let i = 0; i < MAX_OPEN_PER_PROJECT; i++) oq.file({ projectId: open.id, questions: [{ question: `Question ${i}?`, default_answer: "Yes" }] })
    const { call } = await connect()
    const res = await call("ask_owner", { project: open.id, questions: QS })
    expect(res).toMatchObject({ error: true, text: `Mutley already has ${MAX_OPEN_PER_PROJECT} open questions for this project. Group them, or wait for answers.` })
  })

  it("a Box Yard process without the Inbox", async () => {
    const { connect, deps, open } = setup()
    const { call } = await connect({ kind: "coordinator" }, { ...deps, ownerQuestions: undefined })
    const res = await call("ask_owner", { project: open.id, questions: QS })
    expect(res).toMatchObject({ error: true, text: "Mutley's Inbox questions are not available in this Box Yard process." })
  })
})

describe("send_to_captain and ask_captain settle a waiting question", () => {
  it("send_to_captain marks the project's waiting question handled", async () => {
    const { connect, open, secret, oq, sent, states } = setup()
    oq.captainAsked(open.id, "Postgres or SQLite?")
    const { call } = await connect()
    expect((await call("send_to_captain", { project: "open", message: "Use Postgres." })).error).toBe(false)
    expect(sent).toEqual([{ tool: "send_to_captain", projectId: open.id }])
    expect(oq.waiting(open.id)).toBeNull()
    expect(states()).toEqual(["handled"])
    // Another project's message leaves it alone.
    oq.captainAsked(open.id, "And the cache?")
    await call("send_to_captain", { project: secret.id, message: "Status?" })
    expect(oq.waiting(open.id)).not.toBeNull()
  })

  it("ask_captain marks it handled too", async () => {
    const { connect, open, oq, states } = setup()
    oq.captainAsked(open.id, "Postgres or SQLite?")
    const { call } = await connect()
    expect((await call("ask_captain", { project: "open", message: "Use Postgres. Anything else?" })).json()).toEqual({ reply: "Done." })
    expect(oq.waiting(open.id)).toBeNull()
    expect(states()).toEqual(["handled"])
  })

  it("ask_captain to an unknown project fails without touching anything", async () => {
    const { connect, open, oq, sent } = setup()
    oq.captainAsked(open.id, "Postgres or SQLite?")
    const { call } = await connect()
    expect(await call("ask_captain", { project: "nope", message: "Hi" })).toMatchObject({ error: true, text: 'No project "nope". Use list_projects.' })
    expect(sent).toEqual([])
    expect(oq.waiting(open.id)).not.toBeNull()
  })
})

describe("list_inbox", () => {
  it("is the task list as before while no question is open", async () => {
    const { connect } = setup()
    const { call } = await connect()
    expect((await call("list_inbox")).json()).toEqual([])
  })

  it("adds open questions, without a status-only project's content", async () => {
    const { connect, open, secret, oq } = setup()
    const filed = oq.file({ projectId: open.id, questions: QS }).question
    oq.captainAsked(secret.id, "SEALED-WORDS: may I spend $40 on GPUs?")
    oq.captainAsked(open.id, "Still waiting, not in the Inbox yet")
    const sealedItem = oq.listOpen(secret.id)[0]!
    const { call } = await connect()
    // Newest first: the sealed one was filed last.
    const res = await call("list_inbox")
    expect(res.text).not.toContain("SEALED-WORDS")
    expect(res.text).not.toContain("Still waiting")
    const out = res.json()
    expect(out.tasks).toEqual([])
    expect(out.ownerQuestions).toEqual([
      { id: sealedItem.id, project: "secret", statusOnly: true, text: "(status only: ask the project's Captain)", filedBy: "captain", createdAt: new Date(sealedItem.createdAt).toISOString() },
      { id: filed.id, project: "open", text: filed.text, filedBy: "coordinator", createdAt: new Date(filed.createdAt).toISOString() },
    ])
  })

  it("a Captain's list_inbox stays its task list", async () => {
    const { connect, open, oq } = setup()
    oq.file({ projectId: open.id, questions: QS })
    const { call } = await connect({ kind: "captain", projectId: open.id })
    expect((await call("list_inbox")).json()).toEqual([])
  })
})
