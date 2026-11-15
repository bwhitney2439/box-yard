// Questions for Cody from a project's Captain, as Inbox items (docs/specs/inbox-owner-questions.md › Web UI): the
// list (GET /api/owner-questions, kept live by the owner.question event), answering and dismissing them, and the
// `?ask=oq_…` URL that opens one's answer sheet (OwnerQuestionSheet.tsx) on top of whatever is open, so Back closes it
// and a notification can link to it. The rows are OwnerQuestionRows.tsx, in "Waiting on you".
//
// The cache keeps an item closed in another tab (answered or dismissed there), so its row dims in place until the
// list re-sorts (useStableOrder) and an open sheet says "Already answered". An item this tab answers or dismisses
// leaves the cache at once: its row goes.
import { useCallback, useMemo } from "react"
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query"
import type { OwnerQuestion } from "../../../shared/ownerQuestions"
import { api, clientId } from "./api"
import { deferClose, undoClose, usePendingCloses, UNDO_MS } from "./inbox"
import { playSendSound } from "./sendSound"
import { toast } from "./toast"
import type { QUIET } from "./queries"

export const OWNER_QUESTIONS_KEY = ["owner-questions"] as const
/** The URL's search param naming the item whose sheet is open. */
export const ASK_PARAM = "ask"

/** Newest first, as the server sends them. */
export const newestFirst = (a: OwnerQuestion, b: OwnerQuestion) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1)

/** The Inbox's items: the open ones, and any closed in another tab since the list loaded. */
export const useOwnerQuestions = (o?: typeof QUIET) =>
  useQuery({
    queryKey: OWNER_QUESTIONS_KEY,
    queryFn: () => api<OwnerQuestion[]>("/api/owner-questions"),
    notifyOnChangeProps: o?.notifyOnChangeProps,
  })

/** Still waiting on Cody: open, and not dismissed in its Undo window. */
export const isOpenQuestion = (q: OwnerQuestion, closing: ReadonlySet<string>) => q.state === "open" && !closing.has(q.id)

/** The open items, newest first (the Inbox's count, its badge and the tab title). */
export function useOpenOwnerQuestions(): OwnerQuestion[] {
  const { data } = useOwnerQuestions()
  const closing = usePendingCloses()
  return useMemo(() => (data ?? []).filter((q) => isOpenQuestion(q, closing)), [data, closing])
}

/** Items this tab answered or dismissed: their closing event takes them out of the list rather than dimming them. */
const closedHere = new Set<string>()

const drop = (qc: QueryClient, id: string) => qc.setQueryData<OwnerQuestion[]>(OWNER_QUESTIONS_KEY, (list) => list?.filter((q) => q.id !== id))

/** The owner.question event (lib/stream.ts): a new item joins the list; one closed elsewhere stays, closed. */
export function applyOwnerQuestion(qc: QueryClient, item: OwnerQuestion) {
  if (item.state !== "open" && closedHere.has(item.id)) return void drop(qc, item.id)
  qc.setQueryData<OwnerQuestion[]>(OWNER_QUESTIONS_KEY, (list) => {
    if (!list) return item.state === "open" ? [item] : list
    const at = list.findIndex((q) => q.id === item.id)
    if (at < 0) return item.state === "open" ? [item, ...list].sort(newestFirst) : list
    const next = list.slice()
    next[at] = item
    return next
  })
}

/** Send Cody's answers (one, typed, for a plain item: key PLAIN_KEY). The send sound plays; the item leaves the list. */
export function useAnswerOwnerQuestion(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { key: string; answers: string[] }) =>
      api<OwnerQuestion>(`/api/owner-questions/${encodeURIComponent(id)}/answers`, { body: { id: clientId("chat"), key: input.key, answers: input.answers } }),
    onSuccess: () => {
      playSendSound()
      closedHere.add(id)
      drop(qc, id)
    },
    onError: () => {
      playSendSound("failed")
      void qc.invalidateQueries({ queryKey: OWNER_QUESTIONS_KEY })
    },
  })
}

/**
 * Dismiss: the row goes at once with a 5-second Undo, and the dismiss is only sent once the window has passed (the
 * Inbox's deferClose, keyed by the item's id). Box Yard then tells the Coordinator and the Captain, quietly.
 */
export function useDismissOwnerQuestion() {
  const qc = useQueryClient()
  return useCallback(
    (item: Pick<OwnerQuestion, "id">, label = "Question dismissed") => {
      const send = () =>
        sendDismiss(item.id).then(
          () => {
            closedHere.add(item.id)
            drop(qc, item.id)
          },
          (err: Error) => {
            toast.error("Couldn't dismiss the question", err.message)
            void qc.invalidateQueries({ queryKey: OWNER_QUESTIONS_KEY })
            throw err
          },
        )
      if (!deferClose(item.id, send, UNDO_MS)) return
      toast.info(label, "Its Captain and the Coordinator get a quiet note.", { action: { label: "Undo", onClick: () => undoClose(item.id) }, duration: UNDO_MS })
    },
    [qc],
  )
}

/** POST …/dismiss. A dismiss still in its Undo window as the page goes is sent by lib/inbox.ts's pagehide flush. */
const sendDismiss = (id: string) => api<OwnerQuestion>(`/api/owner-questions/${encodeURIComponent(id)}/dismiss`, { body: {} })

// ------------------------------------------------------------------ the ?ask= URL

/** A link that opens the item's sheet (the notifications' href). */
export const ownerQuestionHref = (id: string) => `/?${ASK_PARAM}=${encodeURIComponent(id)}`

/** Marks the history entry openOwnerQuestion pushed, so closing goes back instead of stacking another entry. */
const MARK = "boxyardAsk"

function urlWith(id: string | null) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set(ASK_PARAM, id)
  else url.searchParams.delete(ASK_PARAM)
  return url.pathname + url.search + url.hash
}

const marked = () => Boolean((history.state as Record<string, unknown> | null)?.[MARK])

/** Opens the item's sheet over the page that's open: a step in history, so Back closes it. */
export function openOwnerQuestion(id: string) {
  const to = urlWith(id)
  // Already showing one: swap in place, so one Back still closes it.
  if (new URL(window.location.href).searchParams.has(ASK_PARAM)) history.replaceState(history.state, "", to)
  else history.pushState({ ...(history.state as object | null), [MARK]: true }, "", to)
}

/** Closes the sheet: back to the entry it was opened from, or (a direct visit) the same page without it. */
export function closeOwnerQuestion() {
  if (marked()) history.back()
  else history.replaceState(history.state, "", urlWith(null))
}
