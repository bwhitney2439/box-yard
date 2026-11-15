// Questions for Cody from a project's Captain, as Inbox items (docs/specs/inbox-owner-questions.md). A Captain marks a
// reply that holds one with OWNER_QUESTION_MARKER; the Coordinator files it with ask_owner (several questions, each with
// a default and options, like ask_user), or Box Yard files the Captain's own words after a wait (the backup). Cody's
// answer goes back as one message (answerMessage). Pure functions only: server/ownerQuestions.ts does the rest.

import { formatAnswers, type AskQuestion } from "./askQuestions.js"
import { withOwner } from "./owner.js"

/** An Inbox item: a Captain's question for Cody. The web gets open ones only. */
export interface OwnerQuestion {
  id: string
  projectId: string
  state: "open" | "answered" | "dismissed"
  /** coordinator: ask_owner; backup: Box Yard, after the wait; captain: a status-only project's Captain, at once. */
  filedBy: OwnerQuestionFiler
  intro: string | null
  /** Null: a plain question (the Captain's own words); the form shows one answer box. */
  questions: AskQuestion[] | null
  /** Readable on its own: the questions as text (questionsText), or the Captain's words. */
  text: string
  createdAt: number
  closedAt: number | null
}

export type OwnerQuestionFiler = "coordinator" | "backup" | "captain"

/** Every state a row can be in; only open, answered and dismissed rows are Inbox items (OwnerQuestion). */
export type OwnerQuestionRowState = "waiting" | "open" | "answered" | "dismissed" | "grouped" | "handled"

/** At most this many open items per project: past it the Coordinator has to group. */
export const MAX_OPEN_PER_PROJECT = 10
/** The Captain reply that raised a question is kept up to this length. */
export const MAX_CAPTAIN_TEXT = 4000
/** How long a Captain question waits for an Inbox item before the backup files it (decision 2). */
export const BACKUP_WAIT_MS = 5 * 60_000
/** While the Coordinator is mid-turn the backup holds a question, but no longer than this after it was asked. */
export const BACKUP_BUSY_HOLD_MS = 30 * 60_000
/** How often the backup looks for questions past their wait. */
export const BACKUP_SWEEP_MS = 60_000
/** The key a plain item's answer is sent with (a questions item uses askKey). */
export const PLAIN_KEY = "plain"

/** The hidden line a Captain ends a reply with when it holds a question only Cody can answer. */
export const OWNER_QUESTION_MARKER = "<!-- boxyard-owner-question -->"
const MARKER_RE = /<!--\s*boxyard-owner-question\s*-->/gi

/** The text without the owner-question marker, and whether it had one (the same shape as takeFyiMarker). */
export function takeOwnerQuestionMarker(text: string): { text: string; asked: boolean } {
  const stripped = text.replace(MARKER_RE, "")
  if (stripped === text) return { text, asked: false }
  return { text: stripped.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(), asked: true }
}

/** The Inbox answer message's header line: the item, and the Captain it's for. */
export function answerHeader(id: string, projectId: string, projectName: string): string {
  return `[Inbox answer ${id} · Captain for "${projectName}" (${projectId})]`
}

/** The first line of the item's text, for notices and notifications (Markdown emphasis and all, shortened). */
export function firstLine(item: Pick<OwnerQuestion, "questions" | "text">, max = 200): string {
  const line = (item.questions?.[0]?.question ?? item.text).split("\n").find((l) => l.trim())?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Cody's answer as the one message it goes out as. A Coordinator item goes to the Coordinator, to pass on with
 * send_to_captain; a backup or status-only item goes straight to the Captain, quoting its question. Only Box Yard's
 * own words go through withOwner, never the questions or answers.
 */
export function answerMessage(item: Pick<OwnerQuestion, "id" | "projectId" | "filedBy" | "questions" | "text">, answers: readonly string[], projectName: string, ownerName?: string): string {
  const head = answerHeader(item.id, item.projectId, projectName)
  const lead =
    item.filedBy === "coordinator"
      ? `Cody answered the question you filed for the Captain for "${projectName}". Pass it on with send_to_captain, with any context it needs.`
      : "Cody answered your question from Cody's Inbox."
  const body = item.questions ? formatAnswers(item.questions, answers) : `${quoted(item)}My answer:\n\n${(answers[0] ?? "").trim()}`
  return `${head}\n${withOwner(lead, ownerName)}\n\n${body}`
}

/** A plain item's question, quoted, so the Captain knows which one this answers (it may have moved on). */
function quoted(item: Pick<OwnerQuestion, "filedBy" | "text">): string {
  if (item.filedBy === "coordinator") return ""
  const text = item.text.length > 600 ? `${item.text.slice(0, 599)}…` : item.text
  return `${text.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n")}\n\n`
}
