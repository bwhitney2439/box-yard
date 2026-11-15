// The answer sheet for an Inbox question (docs/specs/inbox-owner-questions.md › The answer sheet), mounted once in the
// app and shown while the URL has `?ask=oq_…` (a row in "Waiting on you", a notification), on top of whatever is open:
// Back closes it. A sheet from the bottom on a phone, a centred dialog on a wider screen, Close (×) top right.
//
// Several questions go through the task ask card (AskQuestions.tsx), one at a time with the default picked, which
// keeps answers in progress per item; a plain question (the Captain's own words) is Markdown and one answer box.
// Dismiss closes the sheet and hides the row with a 5-second Undo. An item closed in another tab says so in place.
import { useCallback, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { useSearchParams } from "wouter"
import { Send } from "lucide-react"
import { PLAIN_KEY, type OwnerQuestion } from "../../../shared/ownerQuestions"
import { ASK_PARAM, closeOwnerQuestion, useAnswerOwnerQuestion, useDismissOwnerQuestion, useOwnerQuestions } from "../lib/ownerQuestions"
import { useProjects } from "../lib/queries"
import { useTiles } from "../lib/taskTiles"
import { ApiError } from "../lib/api"
import { AskQuestions } from "./AskQuestions"
import { Loading } from "./Loading"
import { Modal } from "./Modal"
import { projectColorStyle } from "./TaskIcon"
import { Button, Markdown, TimeAgo, cx } from "./ui"

/** Mounted once in the app: the sheet for the item `?ask=` names. */
export function OwnerQuestionSheet() {
  const [params] = useSearchParams()
  const id = params.get(ASK_PARAM)
  return id ? <Sheet key={id} id={id} /> : null
}

const FILED_BY: Record<OwnerQuestion["filedBy"], string> = {
  coordinator: "Filed by the Coordinator",
  backup: "Filed by Box Yard",
  captain: "From the Captain",
}

function Sheet({ id }: { id: string }) {
  const list = useOwnerQuestions()
  const projects = useProjects()
  const colors = useTiles().colors
  const found = list.data?.find((q) => q.id === id)
  // Answered here, it leaves the list a moment before the sheet closes: keep showing it till then.
  const seen = useRef<OwnerQuestion | undefined>(undefined)
  const sent = useRef(false)
  if (found) seen.current = found
  const item = found ?? (sent.current ? seen.current : undefined)
  const [dirty, setDirty] = useState(false)
  const project = item ? projects.data?.find((p) => p.id === item.projectId) : undefined
  const name = project?.name ?? "a project"

  const title = item ? (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden style={projectColorStyle(colors.get(item.projectId))} className={cx("h-2.5 w-2.5 shrink-0 rounded-[3px]", colors.get(item.projectId) ? "bg-(--pc)" : "bg-zinc-500")} />
      <span className="min-w-0 truncate">Captain for {name} asks</span>
    </span>
  ) : (
    "A Captain's question"
  )
  const description = item ? (
    <>
      {FILED_BY[item.filedBy]} · <TimeAgo ts={item.createdAt} />
    </>
  ) : undefined

  let body
  if (!item) body = list.isLoading ? <Loading kind="rows" label="Loading the question" count={2} /> : <Closed text="This question isn't in your Inbox any more." />
  else if (item.state !== "open") body = <Closed text={item.state === "answered" ? "Already answered" : "Already dismissed"} />
  else if (item.questions?.length) body = <Questions item={item} sent={sent} />
  else body = <PlainQuestion item={item} onDirty={setDirty} sent={sent} />

  return (
    <Modal
      placement="sheet"
      size="md"
      title={title}
      description={description}
      dirty={dirty}
      onClose={closeOwnerQuestion}
      footer={item?.state === "open" ? <DismissFooter item={item} name={name} /> : undefined}
    >
      <div data-testid="owner-question-sheet" data-question={id}>
        {body}
      </div>
    </Modal>
  )
}

function Closed({ text }: { text: string }) {
  return (
    <p role="status" data-testid="owner-question-closed" className="py-4 text-center text-sm text-zinc-400">
      {text}
    </p>
  )
}

/** Dismiss: secondary, at the foot. The row goes now; Undo (a toast) brings it back for 5 seconds. */
function DismissFooter({ item, name }: { item: OwnerQuestion; name: string }) {
  const dismiss = useDismissOwnerQuestion()
  return (
    <Button
      type="button"
      variant="ghost"
      data-testid="owner-question-dismiss"
      onClick={() => {
        dismiss(item, `Dismissed the Captain for ${name}'s question`)
        closeOwnerQuestion()
      }}
    >
      Dismiss
    </Button>
  )
}

/** Set while this sheet's answer is on its way: the item leaves the list as it lands, and the sheet still shows it. */
type Sending = { current: boolean }

/** Sends, then closes the sheet; a failed send leaves it open, its error shown. */
function sending(sent: Sending, send: Promise<unknown>): Promise<void> {
  sent.current = true
  return send.then(closeOwnerQuestion, (err: unknown) => {
    sent.current = false
    throw err
  })
}

/** Several questions: the task ask card, sending to this item. It keeps answers in progress under the item's id. */
function Questions({ item, sent }: { item: OwnerQuestion; sent: Sending }) {
  const answer = useAnswerOwnerQuestion(item.id)
  const { mutateAsync } = answer
  const send = useCallback((key: string, answers: string[]) => sending(sent, mutateAsync({ key, answers })), [mutateAsync, sent])
  return <AskQuestions taskId={item.id} question={item.text} questions={item.questions!} askedAt={null} label="Your answers" submit={{ send, pending: answer.isPending }} />
}

/** A plain question: the Captain's own words, one box for the answer, and Send. ⌘/Ctrl+Enter sends. */
function PlainQuestion({ item, onDirty, sent }: { item: OwnerQuestion; onDirty: (dirty: boolean) => void; sent: Sending }) {
  const answer = useAnswerOwnerQuestion(item.id)
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (answer.isPending) return
    if (!text.trim()) return setError("Type your answer first.")
    setError(null)
    sending(sent, answer.mutateAsync({ key: PLAIN_KEY, answers: [text.trim()] })).catch((err: Error) =>
      setError(err instanceof ApiError && err.status === 409 ? "This question was answered or dismissed meanwhile." : `Couldn't send the answer: ${err.message}`),
    )
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) submit(e)
  }
  return (
    <form noValidate onSubmit={submit} className="space-y-3">
      <div data-testid="owner-question-text" className="text-sm leading-relaxed wrap-anywhere text-zinc-100 [&_.prose-chat>:first-child]:mt-0! [&_.prose-chat>:last-child]:mb-0!">
        <Markdown>{item.text}</Markdown>
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-zinc-400">Your answer</span>
        <textarea
          data-testid="owner-question-answer"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
            onDirty(Boolean(e.target.value.trim()))
          }}
          onKeyDown={onKeyDown}
          rows={4}
          maxLength={4000}
          placeholder="Type your answer"
          enterKeyHint="send"
          aria-describedby={error ? `${item.id}-error` : undefined}
          // 16px under a finger: iOS zooms the page into a field whose text is smaller as it takes the focus.
          className="block w-full min-w-0 resize-y rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:border-amber-500/60 focus-visible:outline-none pointer-coarse:text-base"
        />
      </label>
      {error && (
        <p id={`${item.id}-error`} role="alert" data-testid="owner-question-error" className="text-xs text-red-300">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" data-testid="owner-question-send" loading={answer.isPending} className="max-sm:w-full">
          {!answer.isPending && <Send className="h-3.5 w-3.5" aria-hidden />}
          {answer.isPending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  )
}
