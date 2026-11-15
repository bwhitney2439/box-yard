// Cody's Inbox questions from project Captains (docs/specs/inbox-owner-questions.md): the owner_questions table's
// reads and writes, filing (the Coordinator's ask_owner, a status-only project's Captain, the backup), answering and
// dismissing (and where each sends its message), the backup sweep, and the notifications. Reads and writes store.db
// directly, as HookStore does.

import type { DB } from "./db.js"
import type { Store } from "./store.js"
import { BadRequestError, ConflictError, NotFoundError, json, newId } from "./store.js"
import type { UiEvent } from "../shared/types.js"
import { answersProblem, askKey, MAX_ANSWER_TEXT, normalizeQuestions, questionsProblem, questionsText, type AskQuestion } from "../shared/askQuestions.js"
import { withOwner } from "../shared/owner.js"
import {
  answerMessage,
  BACKUP_BUSY_HOLD_MS,
  BACKUP_SWEEP_MS,
  BACKUP_WAIT_MS,
  firstLine,
  MAX_CAPTAIN_TEXT,
  MAX_OPEN_PER_PROJECT,
  PLAIN_KEY,
  type OwnerQuestion,
  type OwnerQuestionFiler,
  type OwnerQuestionRowState,
} from "../shared/ownerQuestions.js"

interface Row {
  id: string
  project_id: string
  state: OwnerQuestionRowState
  filed_by: OwnerQuestionFiler | null
  intro: string | null
  questions_json: string | null
  text: string
  captain_text: string | null
  captain_message_id: string | null
  grouped_into: string | null
  answers_json: string | null
  due_at: number | null
  created_at: number
  updated_at: number
  closed_at: number | null
}

interface StoredAnswer {
  answers: string[]
  messageId: string | null
}

const INBOX_STATES = new Set<OwnerQuestionRowState>(["open", "answered", "dismissed"])

export interface OwnerQuestionsDeps {
  db: DB
  store: Pick<Store, "getProject" | "addChat" | "addBoxNotification">
  hub: { broadcast(event: UiEvent): void }
  ownerName: () => string | undefined
  /** The project's identity says "Coordinator sees: status only" (docs/identities.md). */
  statusOnly: (projectId: string) => boolean
  /** The Coordinator is mid-turn (orchestrator.busy): that turn may still file a waiting question. */
  coordinatorBusy: () => boolean
  /** Cody's message to the Coordinator, starting a turn (orchestrator.hookMessage). */
  messageCoordinator: (content: string, meta: Record<string, unknown>) => void
  /** Cody's message to the project's Captain (captains.send with source "cody"); `id` is the client's message id. */
  messageCaptain: (projectId: string, content: string, id?: string) => void
  /** A notice on the Captain's chat that it reads with its next turn, without starting one (captains.projectNotice). */
  captainNotice: (projectId: string, content: string, meta: Record<string, unknown>) => void
  now?: () => number
}

/** What filing an ask_owner item did. */
export interface Filed {
  question: OwnerQuestion
  /** An open item with the same questions was already there: it's that one, and nothing was filed. */
  duplicate: boolean
  /** How many of the Captain's waiting questions this item took over (their backup is off). */
  grouped: number
}

export class OwnerQuestions {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly d: OwnerQuestionsDeps) {}

  private get db() {
    return this.d.db
  }

  private now() {
    return this.d.now?.() ?? Date.now()
  }

  // ---------- reads

  /** Open Inbox items, newest first; for one project when given. */
  listOpen(projectId?: string): OwnerQuestion[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT * FROM owner_questions WHERE state = 'open' AND project_id = ? ORDER BY created_at DESC, rowid DESC").all(projectId)
        : this.db.prepare("SELECT * FROM owner_questions WHERE state = 'open' ORDER BY created_at DESC, rowid DESC").all()
    ) as Row[]
    return rows.map(toItem)
  }

  /** An Inbox item (open or closed); null for an unknown id or a row that never reached the Inbox. */
  get(id: string): OwnerQuestion | null {
    const row = this.row(id)
    return row && INBOX_STATES.has(row.state) ? toItem(row) : null
  }

  /** The project's waiting Captain question, if one waits for an Inbox item. */
  waiting(projectId: string): { id: string; text: string; dueAt: number; createdAt: number } | null {
    const row = this.db.prepare("SELECT * FROM owner_questions WHERE state = 'waiting' AND project_id = ?").get(projectId) as Row | undefined
    return row ? { id: row.id, text: row.text, dueAt: row.due_at ?? row.created_at, createdAt: row.created_at } : null
  }

  private row(id: string): Row | null {
    return (this.db.prepare("SELECT * FROM owner_questions WHERE id = ?").get(id) as Row | undefined) ?? null
  }

  private openCount(projectId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM owner_questions WHERE state = 'open' AND project_id = ?").get(projectId) as { n: number }).n
  }

  // ---------- filing

  /**
   * The Coordinator's ask_owner: an open item with its questions, checked and cleaned up the way ask_user's are. A
   * retry with the same questions gets the open item back (`duplicate`); the project's waiting Captain questions are
   * taken over (`grouped`), so the backup doesn't file them again.
   */
  file(input: { projectId: string; question?: string | null; questions: unknown }): Filed {
    const project = this.d.store.getProject(input.projectId)
    if (!project) throw new NotFoundError(`No project ${input.projectId}`)
    const problem = questionsProblem(input.questions)
    if (problem) throw new BadRequestError(problem)
    const questions = normalizeQuestions(input.questions)
    if (!questions) throw new BadRequestError("questions has no question left after dropping blank ones")
    const key = askKey(questions)
    const same = this.listOpen(project.id).find((q) => q.questions && askKey(q.questions) === key)
    if (same) return { question: same, duplicate: true, grouped: 0 }
    if (this.openCount(project.id) >= MAX_OPEN_PER_PROJECT) {
      throw new BadRequestError(this.own(`Cody already has ${MAX_OPEN_PER_PROJECT} open questions for this project. Group them, or wait for answers.`))
    }
    const intro = input.question?.trim() || null
    const id = newId("oq")
    const now = this.now()
    const grouped = this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO owner_questions (id, project_id, state, filed_by, intro, questions_json, text, created_at, updated_at) VALUES (?, ?, 'open', 'coordinator', ?, ?, ?, ?, ?)")
        .run(id, project.id, intro, JSON.stringify(questions), questionsText(intro, questions), now, now)
      return this.db
        .prepare("UPDATE owner_questions SET state = 'grouped', grouped_into = ?, closed_at = ?, updated_at = ? WHERE state = 'waiting' AND project_id = ?")
        .run(id, now, now, project.id).changes
    })()
    const question = this.get(id)!
    this.announce(question)
    return { question, duplicate: false, grouped }
  }

  /**
   * A Captain's reply marked as a question for Cody (OWNER_QUESTION_MARKER). Usually a waiting row the Coordinator
   * has 5 minutes to file (or settle); a second one while it waits joins it and keeps its clock, so a looping Captain
   * can't flood the Inbox. A status-only project's question goes to the Inbox at once: the Coordinator mustn't read it.
   */
  captainAsked(projectId: string, content: string, messageId?: string | null): void {
    const words = content.trim()
    if (!words || !this.d.store.getProject(projectId)) return
    const now = this.now()
    if (this.d.statusOnly(projectId)) return this.captainFiles(projectId, words, messageId ?? null, now)
    const waiting = this.db.prepare("SELECT * FROM owner_questions WHERE state = 'waiting' AND project_id = ?").get(projectId) as Row | undefined
    if (waiting) {
      this.db
        .prepare("UPDATE owner_questions SET text = ?, captain_text = ?, updated_at = ? WHERE id = ?")
        .run(join(waiting.text, words), join(waiting.captain_text ?? "", words), now, waiting.id)
      return
    }
    this.db
      .prepare("INSERT INTO owner_questions (id, project_id, state, text, captain_text, captain_message_id, due_at, created_at, updated_at) VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?, ?)")
      .run(newId("oq"), projectId, cap(words), cap(words), messageId ?? null, now + BACKUP_WAIT_MS, now, now)
  }

  /** A status-only project's Captain question, straight to the Inbox. Past the open cap it joins the newest such item. */
  private captainFiles(projectId: string, words: string, messageId: string | null, now: number) {
    if (this.openCount(projectId) >= MAX_OPEN_PER_PROJECT) {
      const last = this.db
        .prepare("SELECT * FROM owner_questions WHERE state = 'open' AND project_id = ? AND filed_by = 'captain' ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(projectId) as Row | undefined
      if (last) {
        this.db.prepare("UPDATE owner_questions SET text = ?, captain_text = ?, updated_at = ? WHERE id = ?").run(join(last.text, words), join(last.captain_text ?? "", words), now, last.id)
        return void this.d.hub.broadcast({ type: "owner.question", question: this.get(last.id)! })
      }
    }
    const id = newId("oq")
    this.db
      .prepare("INSERT INTO owner_questions (id, project_id, state, filed_by, text, captain_text, captain_message_id, created_at, updated_at) VALUES (?, ?, 'open', 'captain', ?, ?, ?, ?, ?)")
      .run(id, projectId, cap(words), cap(words), messageId, now, now)
    this.announce(this.get(id)!)
  }

  /** The Coordinator messaged the project's Captain (send_to_captain, ask_captain): it settled what was waiting. */
  coordinatorReplied(projectId: string): number {
    const now = this.now()
    return this.db.prepare("UPDATE owner_questions SET state = 'handled', closed_at = ?, updated_at = ? WHERE state = 'waiting' AND project_id = ?").run(now, now, projectId).changes
  }

  // ---------- the backup

  /** Sweep now and every minute after, so waiting rows survive a restart. */
  start() {
    this.sweepSafely()
    this.timer ??= setInterval(() => this.sweepSafely(), BACKUP_SWEEP_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private sweepSafely() {
    try {
      this.sweep()
    } catch (err) {
      console.error("[owner-questions] backup sweep failed:", err instanceof Error ? err.message : err)
    }
  }

  /**
   * File every Captain question that waited past its due time with no Inbox item: the Captain's own words, as a plain
   * question. A Coordinator mid-turn may still file it, so it's held then, but not past 30 minutes. Returns the ids filed.
   */
  sweep(): string[] {
    const now = this.now()
    const due = this.db.prepare("SELECT * FROM owner_questions WHERE state = 'waiting' AND due_at <= ? ORDER BY created_at ASC").all(now) as Row[]
    const filed: string[] = []
    for (const row of due) {
      if (this.d.coordinatorBusy() && now - row.created_at < BACKUP_BUSY_HOLD_MS) continue
      const changed = this.db.prepare("UPDATE owner_questions SET state = 'open', filed_by = 'backup', updated_at = ? WHERE id = ? AND state = 'waiting'").run(now, row.id).changes
      if (!changed) continue
      filed.push(row.id)
      const item = this.get(row.id)!
      this.announce(item)
      if (!this.d.statusOnly(row.project_id)) {
        this.coordinatorNotice(
          item,
          `📥 **Inbox** filed: the Captain for ${this.projectName(item.projectId)}'s question waited 5 minutes with no Inbox item, so Box Yard put it in the Inbox.`,
        )
      }
    }
    return filed
  }

  // ---------- answering and dismissing

  /**
   * Cody's answer: closes the item and sends it on. A Coordinator item goes to the Coordinator as Cody's message, to
   * pass on; a backup or status-only item goes straight to the Captain (a backup one with a quiet note to the
   * Coordinator). `key` must match the questions answered (askKey, or "plain"); `messageId` is the client's message id,
   * so a resend of the same answer gets the closed item back instead of a conflict.
   */
  answer(id: string, key: string, answers: unknown, messageId?: string): OwnerQuestion {
    const row = this.inboxRow(id)
    if (row.state !== "open") {
      const stored = json<StoredAnswer | null>(row.answers_json, null)
      if (row.state === "answered" && messageId && stored?.messageId === messageId) return toItem(row)
      throw new ConflictError(row.state === "answered" ? "Already answered" : "Already dismissed")
    }
    const item = toItem(row)
    if (key !== (item.questions ? askKey(item.questions) : PLAIN_KEY)) throw new ConflictError("These questions changed")
    const problem = item.questions ? answersProblem(item.questions, answers) : plainProblem(answers)
    if (problem) throw new BadRequestError(problem)
    const given = (answers as string[]).map((a) => a.trim())
    const now = this.now()
    const stored: StoredAnswer = { answers: given, messageId: messageId ?? null }
    const changed = this.db
      .prepare("UPDATE owner_questions SET state = 'answered', answers_json = ?, closed_at = ?, updated_at = ? WHERE id = ? AND state = 'open'")
      .run(JSON.stringify(stored), now, now, id).changes
    if (!changed) return this.answer(id, key, answers, messageId)
    const projectName = this.projectName(item.projectId)
    const text = answerMessage(item, given, projectName, this.d.ownerName())
    try {
      if (item.filedBy === "coordinator") this.d.messageCoordinator(text, { ownerQuestion: id })
      else this.d.messageCaptain(item.projectId, text, messageId)
    } catch (err) {
      // It never went out: the item stays open, so Cody can send it again.
      this.db.prepare("UPDATE owner_questions SET state = 'open', answers_json = NULL, closed_at = NULL, updated_at = ? WHERE id = ? AND state = 'answered'").run(now, id)
      throw err
    }
    if (item.filedBy === "backup" && !this.d.statusOnly(item.projectId)) {
      this.coordinatorNotice(item, `${this.own("📥 **Inbox** answered: Cody answered the Captain for")} ${projectName}'s question; it went to the Captain.`)
    }
    return this.closed(id)
  }

  /** Cody dismissed it: closed, and both sides told quietly (no turn). A status-only project's Coordinator isn't told. */
  dismiss(id: string): OwnerQuestion {
    const row = this.inboxRow(id)
    if (row.state !== "open") throw new ConflictError(row.state === "answered" ? "Already answered" : "Already dismissed")
    const now = this.now()
    const changed = this.db.prepare("UPDATE owner_questions SET state = 'dismissed', closed_at = ?, updated_at = ? WHERE id = ? AND state = 'open'").run(now, now, id).changes
    if (!changed) return this.dismiss(id)
    const item = toItem(row)
    const line = firstLine(item)
    if (!this.d.statusOnly(item.projectId)) {
      this.coordinatorNotice(item, `${this.own("📥 **Inbox** dismissed: Cody dismissed the Captain for")} ${this.projectName(item.projectId)}'s question: ${line}`)
    }
    this.d.captainNotice(item.projectId, `${this.own("📥 **Inbox** dismissed: Cody dismissed your question:")} ${line}`, { ownerQuestion: id })
    return this.closed(id)
  }

  /** The item behind an answer or dismiss route: 404 unless it reached the Inbox. */
  private inboxRow(id: string): Row {
    const row = this.row(id)
    if (!row || !INBOX_STATES.has(row.state)) throw new NotFoundError("No such question")
    return row
  }

  /** After an item closes: its notification read, and every tab told it's gone. */
  private closed(id: string): OwnerQuestion {
    const item = this.get(id)!
    const href = itemHref(id)
    const unread = this.db.prepare("SELECT id FROM notifications WHERE read_at IS NULL AND href = ?").all(href) as { id: string }[]
    if (unread.length) {
      const readAt = this.now()
      this.db.prepare("UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND href = ?").run(readAt, href)
      this.d.hub.broadcast({ type: "notifications.read", ids: unread.map((n) => n.id), readAt })
    }
    this.d.hub.broadcast({ type: "owner.question", question: item })
    return item
  }

  // ---------- telling

  /** A new Inbox item: its notification (toast, voice, system notification) and every tab told. */
  private announce(item: OwnerQuestion) {
    const projectName = this.projectName(item.projectId)
    this.d.store.addBoxNotification({
      title: `Captain for ${projectName} asks`,
      summary: firstLine(item),
      status: "needs_input",
      projectId: item.projectId,
      projectName,
      href: itemHref(item.id),
    })
    this.d.hub.broadcast({ type: "owner.question", question: item })
  }

  /** Box Yard's own words with the owner's name (never applied to questions, answers or names). */
  private own(text: string) {
    return withOwner(text, this.d.ownerName())
  }

  /** A notice on the Coordinator chat it reads with its next turn, without starting one (like a Captain's FYI report). */
  private coordinatorNotice(item: OwnerQuestion, text: string) {
    const msg = this.d.store.addChat("notice", text, { projectId: item.projectId, fyi: true, ownerQuestion: item.id })
    this.d.hub.broadcast({ type: "chat.message", message: msg })
  }

  private projectName(projectId: string): string {
    return this.d.store.getProject(projectId)?.name ?? projectId
  }
}

/** Where a notification about the item opens: the answer sheet over whatever is open. */
export const itemHref = (id: string) => `/?ask=${id}`

function toItem(r: Row): OwnerQuestion {
  return {
    id: r.id,
    projectId: r.project_id,
    state: r.state === "answered" || r.state === "dismissed" ? r.state : "open",
    filedBy: r.filed_by ?? "backup",
    intro: r.intro,
    questions: json<AskQuestion[] | null>(r.questions_json, null),
    text: r.text,
    createdAt: r.created_at,
    closedAt: r.closed_at,
  }
}

function plainProblem(answers: unknown): string | null {
  if (!Array.isArray(answers) || answers.length !== 1) return "Expected 1 answer"
  const [a] = answers
  if (typeof a !== "string" || !a.trim()) return "The question has no answer"
  if (a.length > MAX_ANSWER_TEXT) return `The answer is longer than ${MAX_ANSWER_TEXT} characters`
  return null
}

const cap = (text: string) => (text.length > MAX_CAPTAIN_TEXT ? `${text.slice(0, MAX_CAPTAIN_TEXT - 1)}…` : text)
const join = (before: string, more: string) => cap(before ? `${before}\n\n${more}` : more)
