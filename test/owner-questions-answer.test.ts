import { describe, expect, it } from "vitest"
import { openDb } from "../server/db.js"
import { Store } from "../server/store.js"
import { OwnerQuestions } from "../server/ownerQuestions.js"
import { askKey, normalizeQuestions } from "../shared/askQuestions.js"
import { answerMessage, BACKUP_WAIT_MS, OWNER_QUESTION_MARKER, PLAIN_KEY, takeOwnerQuestionMarker, type OwnerQuestion } from "../shared/ownerQuestions.js"
import { tmpDir } from "./helpers.js"

const QUESTIONS = normalizeQuestions([
  { question: "Which database should the spike use?", default_answer: "Postgres", options: ["SQLite"] },
  { question: "Keep the old API for a release?", default_answer: "Yes", options: ["No"] },
])!

const item = (over: Partial<OwnerQuestion> = {}): OwnerQuestion => ({
  id: "oq_7k2m9x1p4q5r",
  projectId: "prj_1a2b3c4d5e6f",
  state: "open",
  filedBy: "coordinator",
  intro: null,
  questions: QUESTIONS,
  text: "",
  createdAt: 0,
  closedAt: null,
  ...over,
})

describe("takeOwnerQuestionMarker", () => {
  it("strips the marker and says it was there", () => {
    expect(takeOwnerQuestionMarker(`Which region should we use?\n\n${OWNER_QUESTION_MARKER}`)).toEqual({ text: "Which region should we use?", asked: true })
    expect(takeOwnerQuestionMarker("Which region?\n<!--  BoxYard-Owner-Question -->  \nMore.")).toEqual({ text: "Which region?\n\nMore.", asked: true })
  })

  it("leaves a reply without it alone", () => {
    expect(takeOwnerQuestionMarker("  All done.  ")).toEqual({ text: "  All done.  ", asked: false })
  })
})

describe("answerMessage", () => {
  it("tells the Coordinator what was answered and to pass it on", () => {
    expect(answerMessage(item(), ["Postgres", "No, drop it now; nobody calls it"], "box-yard", "Mutley")).toBe(
      [
        '[Inbox answer oq_7k2m9x1p4q5r · Captain for "box-yard" (prj_1a2b3c4d5e6f)]',
        'Mutley answered the question you filed for the Captain for "box-yard". Pass it on with send_to_captain, with any context it needs.',
        "",
        "My answers to your 2 questions:",
        "",
        "1. Which database should the spike use?",
        "   - Postgres (your default)",
        "2. Keep the old API for a release?",
        "   - No, drop it now; nobody calls it (my own answer)",
      ].join("\n"),
    )
  })

  it("marks a picked option as neither default nor typed", () => {
    expect(answerMessage(item(), ["SQLite", "Yes"], "box-yard")).toContain("1. Which database should the spike use?\n   - SQLite\n2. Keep the old API for a release?\n   - Yes (your default)")
  })

  it("never puts the owner's name into the questions or answers", () => {
    const q = normalizeQuestions([{ question: "Does Cody want this?", default_answer: "Ask Cody" }])!
    const text = answerMessage(item({ questions: q }), ["Cody says yes"], "box-yard", "Mutley")
    expect(text).toContain("Mutley answered")
    expect(text).toContain("Does Cody want this?")
    expect(text).toContain("Cody says yes")
  })

  it("answers a plain item to the Captain, quoting its question", () => {
    const text = answerMessage(item({ filedBy: "backup", questions: null, text: "Which region?\nEU or US." }), ["  EU, near the users  "], "box-yard", "Mutley")
    expect(text).toBe(
      [
        '[Inbox answer oq_7k2m9x1p4q5r · Captain for "box-yard" (prj_1a2b3c4d5e6f)]',
        "Mutley answered your question from Mutley's Inbox.",
        "",
        "> Which region?",
        "> EU or US.",
        "",
        "My answer:",
        "",
        "EU, near the users",
      ].join("\n"),
    )
  })
})

describe("where an answer goes", () => {
  function setup(statusOnly = false) {
    const db = openDb(tmpDir())
    const store = new Store(db)
    store.createProject({ id: "prj_demo01", name: "demo" })
    const sent = { coordinator: [] as { content: string; meta: Record<string, unknown> }[], captain: [] as { content: string; id?: string }[], captainNotices: [] as string[] }
    const clock = { now: 1_000_000 }
    const oq = new OwnerQuestions({
      db,
      store,
      hub: { broadcast: () => {} },
      ownerName: () => "Mutley",
      statusOnly: () => statusOnly,
      coordinatorBusy: () => false,
      messageCoordinator: (content, meta) => void sent.coordinator.push({ content, meta }),
      messageCaptain: (_projectId, content, id) => void sent.captain.push({ content, id }),
      captainNotice: (_projectId, content) => void sent.captainNotices.push(content),
      now: () => clock.now,
    })
    const notices = () => store.listChat().filter((m) => m.role === "notice")
    const backupItem = (words = "Which region?") => {
      oq.captainAsked("prj_demo01", words)
      clock.now += BACKUP_WAIT_MS
      return oq.sweep()[0]!
    }
    return { oq, sent, notices, backupItem }
  }

  it("sends a Coordinator item's answer to the Coordinator as Mutley's message, with no notice", () => {
    const { oq, sent, notices } = setup()
    const { question } = oq.file({ projectId: "prj_demo01", questions: QUESTIONS.map((q) => ({ ...q, default_answer: q.defaultAnswer })) })
    oq.answer(question.id, askKey(question.questions!), ["Postgres", "Yes"])
    expect(sent.coordinator).toHaveLength(1)
    expect(sent.coordinator[0]!.meta).toEqual({ ownerQuestion: question.id })
    expect(sent.coordinator[0]!.content).toMatch(new RegExp(`^\\[Inbox answer ${question.id} · Captain for "demo" \\(prj_demo01\\)\\]`))
    expect(sent.captain).toEqual([])
    expect(notices()).toEqual([])
  })

  it("sends a backup item's answer straight to the Captain, with a quiet notice to the Coordinator", () => {
    const { oq, sent, notices, backupItem } = setup()
    const id = backupItem()
    oq.answer(id, PLAIN_KEY, ["eu-west"], "msg_abcdef12")
    expect(sent.coordinator).toEqual([])
    expect(sent.captain).toHaveLength(1)
    expect(sent.captain[0]!.id).toBe("msg_abcdef12")
    expect(sent.captain[0]!.content).toContain("My answer:\n\neu-west")
    const last = notices().at(-1)!
    expect(last.content).toBe("📥 **Inbox** answered: Mutley answered the Captain for demo's question; it went to the Captain.")
    expect(last.meta).toMatchObject({ fyi: true, ownerQuestion: id })
  })

  it("sends a status-only item's answer to the Captain, and the Coordinator hears nothing", () => {
    const { oq, sent, notices } = setup(true)
    oq.captainAsked("prj_demo01", "Which region?")
    const [item] = oq.listOpen()
    oq.answer(item!.id, PLAIN_KEY, ["eu-west"])
    expect(sent.captain).toHaveLength(1)
    expect(sent.coordinator).toEqual([])
    expect(notices()).toEqual([])
  })

  it("tells both sides quietly on dismiss", () => {
    const { oq, sent, notices } = setup()
    const { question } = oq.file({ projectId: "prj_demo01", questions: [{ question: "**Ship** it now?\nOr wait.", default_answer: "Yes" }] })
    oq.dismiss(question.id)
    expect(sent.coordinator).toEqual([])
    expect(sent.captain).toEqual([])
    expect(notices().at(-1)!.content).toBe("📥 **Inbox** dismissed: Mutley dismissed the Captain for demo's question: **Ship** it now?")
    expect(notices().at(-1)!.meta).toMatchObject({ fyi: true })
    expect(sent.captainNotices).toEqual(["📥 **Inbox** dismissed: Mutley dismissed your question: **Ship** it now?"])
  })

  it("tells only the Captain when a status-only item is dismissed", () => {
    const { oq, sent, notices } = setup(true)
    oq.captainAsked("prj_demo01", "Which region?")
    oq.dismiss(oq.listOpen()[0]!.id)
    expect(notices()).toEqual([])
    expect(sent.captainNotices).toEqual(["📥 **Inbox** dismissed: Mutley dismissed your question: Which region?"])
  })
})
