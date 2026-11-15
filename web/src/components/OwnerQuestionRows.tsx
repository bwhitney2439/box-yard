// The Inbox's question rows: a Captain's questions for Cody (docs/specs/inbox-owner-questions.md › In the Inbox), first
// in "Waiting on you" (Sidebar.tsx WaitingOnYou), above the tasks, newest first: they ask, and asks lead. A row is the
// amber question icon, "Captain for <project>" with the project's square, the time, and the first question on a line
// of its own; a tap opens its answer sheet (OwnerQuestionSheet.tsx, `?ask=`). 44px to a finger, a treeitem to the
// keyboard like the task rows. Their order holds while the list updates (useStableOrder): one answered in another tab
// dims in place until the list re-sorts, one dismissed here goes at once (its Undo brings it back).
import { memo, useId, useMemo } from "react"
import { MessageCircleQuestion } from "lucide-react"
import { firstLine, type OwnerQuestion } from "../../../shared/ownerQuestions"
import { isOpenQuestion, newestFirst, openOwnerQuestion } from "../lib/ownerQuestions"
import { useStableOrder } from "../lib/useStableOrder"
import { projectColorStyle } from "./TaskIcon"
import { FOCUS, ROW_BOX, openPart, treeItem } from "./Sidebar"
import { TimeAgo, cx } from "./ui"

type ProjectLine = { name: string; color: Parameters<typeof projectColorStyle>[0] }

/** The tree key of a question's row. */
export const askKey = (id: string) => `ask:${id}`

/** A first question as one plain line: no Markdown marks, which a row can't draw. */
const plainLine = (item: OwnerQuestion) => firstLine(item, 160).replace(/[*_`#>]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim()

/**
 * The rows, at most `limit` (the rest wait behind "Show all n"). `questions` holds every item the list knows,
 * closed ones too, so a row closed elsewhere dims rather than jumps; `closing` are those dismissed in their Undo window.
 */
export const OwnerQuestionRows = memo(function OwnerQuestionRows({ questions, closing, limit, projects }: {
  questions: readonly OwnerQuestion[]
  closing: ReadonlySet<string>
  limit: number
  projects: ReadonlyMap<string, ProjectLine>
}) {
  // A new item, or one that left the list, sorts afresh: a question never waits off screen for the list to settle.
  const ids = useMemo(() => questions.map((q) => q.id).join(), [questions])
  const stable = useStableOrder(questions, { key: (q) => q.id, compare: newestFirst, include: (q) => isOpenQuestion(q, closing), resetKey: ids })
  // `limit` counts open rows: a dimmed one stays in its place without taking one.
  let open = 0
  const shown = stable.entries.filter((e) => !closing.has(e.item.id) && (e.stale || open++ < limit))
  if (!shown.length) return null
  return (
    <div ref={stable.listRef} data-testid="owner-question-rows" className="space-y-px">
      {shown.map(({ item, stale }) => (
        <OwnerQuestionRow key={item.id} item={item} stale={stale} project={projects.get(item.projectId)} />
      ))}
    </div>
  )
})

const OwnerQuestionRow = memo(function OwnerQuestionRow({ item, stale, project }: { item: OwnerQuestion; stale: boolean; project: ProjectLine | undefined }) {
  const id = useId()
  const name = project?.name ?? "a project"
  const line = plainLine(item)
  return (
    <div
      {...treeItem(askKey(item.id), 2, id)}
      data-stable-key={item.id}
      data-testid="owner-question-row"
      data-closed={stale || undefined}
      className={cx("flex items-center rounded-lg transition", FOCUS, stale ? "text-zinc-500 opacity-60" : "text-zinc-200 hover:bg-zinc-900")}
    >
      <button
        type="button"
        onClick={() => openOwnerQuestion(item.id)}
        {...openPart(id)}
        title={`Captain for ${name} asks: ${line}`}
        className={cx(ROW_BOX, "grid min-w-0 flex-1 grid-cols-[1.25rem_minmax(0,1fr)_auto] content-center items-center gap-x-2.5 py-1.5 pointer-coarse:min-h-11")}
      >
        <MessageCircleQuestion aria-hidden className={cx("row-start-1 h-4 w-4 justify-self-center", stale ? "text-zinc-500" : "text-amber-400")} />
        <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-1.5 text-sm">
          {/* The project's square, as under More projects: a round dot would read as a task's state. */}
          <span aria-hidden style={projectColorStyle(project?.color)} className={cx("h-2 w-2 shrink-0 rounded-[2px]", project?.color ? "bg-(--pc)" : "bg-zinc-500")} />
          <span className="min-w-0 truncate">Captain for {name}</span>
          <span className="sr-only">{stale ? `, ${item.state}` : " asks"}: </span>
        </span>
        <span className="col-span-2 col-start-2 row-start-2 min-w-0 truncate text-xs leading-4 text-zinc-400">{line}</span>
        {/* After the question to a screen reader; top right to the eye. */}
        <span className="col-start-3 row-start-1 text-xs leading-5 text-zinc-500 tabular-nums @max-[13rem]/side:hidden">
          <span className="sr-only">, </span>
          <TimeAgo ts={item.createdAt} />
        </span>
      </button>
    </div>
  )
})
