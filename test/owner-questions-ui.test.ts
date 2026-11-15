// @vitest-environment happy-dom
// The Inbox's questions from Captains (docs/specs/inbox-owner-questions.md › Web UI): their rows lead "Waiting on you"
// and count in its badge (amber: they ask), the menu button's and the tab title's; a row or `?ask=` opens the answer
// sheet; several questions go through the ask card (default, option, own answer, Back and Next, Send), a plain one
// through one box; Dismiss hides the row with Undo; an item closed elsewhere says so; a phone shows it all too.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { App } from "../web/src/App.js"
import { warmLazyParts } from "../web/src/components/LazyPart.js"
import { DEFAULT_SETTINGS } from "../server/settings.js"
import { keys } from "../web/src/lib/queries.js"
import { OWNER_QUESTIONS_KEY, applyOwnerQuestion } from "../web/src/lib/ownerQuestions.js"
import { resetAskProgress } from "../web/src/lib/askAnswers.js"
import { setChatProjectFilter } from "../web/src/lib/projectBar.js"
import { WAITING_FOLD, closeSidebarDrawer, setSidebarCollapsed, unfoldSidebarGroup } from "../web/src/lib/sidebar.js"
import { currentToasts, dismiss } from "../web/src/lib/toast.js"
import { resetColumns } from "../web/src/lib/columns.js"
import { APP_HOME } from "../web/src/lib/navigation.js"
import { CUE_DOT } from "../web/src/components/TaskIcon.js"
import { askKey, questionsText, type AskQuestion } from "../shared/askQuestions.js"
import type { OwnerQuestion } from "../shared/ownerQuestions.js"
import type { Project, Task, TaskStatus } from "../shared/types"
import { itemName, sidebarGroup, treeItems } from "./sidebarTree.js"

beforeAll(() => warmLazyParts())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ASKS_AMBER = CUE_DOT.asks.split(" ").map((c) => `.${CSS.escape(c)}`).join("")
const now = Date.now()
const project = (id: string, name: string) => ({ id, name, repo: null, description: "", notes: [], envKeys: [], baseBranch: "main", runner: "box", identityId: "idn_default", gpuMachine: { gpuTypes: null, cloud: null, minRamGb: null, minVcpus: null }, docker: { image: null, dockerfile: null }, createdAt: now, color: null }) as unknown as Project
const task = (id: string, projectId: string, title: string, status: TaskStatus) =>
  ({ id, projectId, title, status, prompt: "", prUrl: null, prState: null, prMergedAt: null, previews: [], waitFor: [], question: null, error: null, scheduleId: null, outcome: null, createdAt: now - 60_000, updatedAt: now - 60_000 }) as unknown as Task

const YARD = project("prj_yard01", "box-yard")
const SITE = project("prj_site01", "marketing-site")
const ASK = task("task_ask001", YARD.id, "Check SSH into the bench", "needs_input")
const PR = task("task_pr0001", SITE.id, "Refresh the portfolio", "pr_ready")

const QUESTIONS: AskQuestion[] = [
  { question: "Which database should the spike use?", defaultAnswer: "Postgres", options: ["SQLite"] },
  { question: "Keep the old API for a release?", defaultAnswer: "Yes, one release", options: ["No, drop it now"] },
]
const SEVERAL: OwnerQuestion = {
  id: "oq_several00001",
  projectId: YARD.id,
  state: "open",
  filedBy: "coordinator",
  intro: "Two choices before the spike starts.",
  questions: QUESTIONS,
  text: questionsText("Two choices before the spike starts.", QUESTIONS),
  createdAt: now - 120_000,
  closedAt: null,
}
const PLAIN: OwnerQuestion = {
  id: "oq_plain0000001",
  projectId: SITE.id,
  state: "open",
  filedBy: "backup",
  intro: null,
  questions: null,
  text: "Should the **launch page** go live on Monday or wait for the new photos?",
  createdAt: now - 30_000,
  closedAt: null,
}

class FakeEventSource {
  onmessage: unknown = null
  onerror: unknown = null
  onopen: unknown = null
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

let root: Root
let host: HTMLElement
let qc: QueryClient
let posts: { url: string; body: Record<string, unknown> }[]

const viewport = (width: number, height = 900) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height })

function render(path = APP_HOME, questions: OwnerQuestion[] = [SEVERAL, PLAIN], tasks: Task[] = [ASK, PR]) {
  history.replaceState(null, "", path)
  sessionStorage.setItem("box-yard:landed", "1")
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  qc.setQueryData(keys.me, { authed: true, authRequired: false })
  qc.setQueryData(keys.agentSettings, { settings: DEFAULT_SETTINGS, sources: {}, defaults: DEFAULT_SETTINGS })
  qc.setQueryData(keys.health, { ok: true, provider: "mock", mock: true, bus: "file", claude: { available: true, version: "x" }, problems: [], pool: {}, orchestratorBusy: false, scheduler: "local" })
  qc.setQueryData(keys.chat, [])
  qc.setQueryData(keys.chatBusy, false)
  qc.setQueryData(keys.tasks, tasks)
  qc.setQueryData(keys.projects, [YARD, SITE])
  qc.setQueryData(OWNER_QUESTIONS_KEY, questions)
  for (const k of [keys.artifacts, keys.schedules, keys.boxes, keys.notifications]) qc.setQueryData(k, [])
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(App))))
}

const $ = <T extends Element = HTMLElement>(sel: string, within: ParentNode = document) => within.querySelector<T>(sel)
const nav = () => $("nav[aria-label='Projects and tasks']")
const waiting = () => sidebarGroup(nav()!, "Waiting on you")!
const sheet = () => $("[data-testid=owner-question-sheet]")?.closest<HTMLElement>("[role=dialog]") ?? null
const askParam = () => new URLSearchParams(location.search).get("ask")
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-testid=owner-question-row]")]
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })))
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(() => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
const radios = () => [...sheet()!.querySelectorAll<HTMLInputElement>('[data-testid=ask-question] input[type="radio"]')]
const checked = () => radios().findIndex((r) => r.checked)

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  resetAskProgress()
  viewport(1440)
  posts = []
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"))
      posts.push({ url, body })
      const id = /owner-questions\/([^/]+)\//.exec(url)?.[1]
      const item = [SEVERAL, PLAIN].find((q) => q.id === id)!
      return new Response(JSON.stringify({ ...item, state: url.endsWith("/dismiss") ? "dismissed" : "answered", closedAt: Date.now() }), { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Promise(() => {})
  })
  vi.stubGlobal("EventSource", FakeEventSource)
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ""
  for (const t of currentToasts()) dismiss(t.id)
  act(() => {
    setChatProjectFilter(null)
    resetColumns()
    setSidebarCollapsed(false)
    closeSidebarDrawer()
    for (const key of [YARD.id, SITE.id, WAITING_FOLD]) unfoldSidebarGroup(key)
  })
  vi.useRealTimers()
  viewport(1024, 768)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the Inbox's question rows", () => {
  it("lead Waiting on you, newest first, and count in its amber badge and the tab title", () => {
    render()
    const group = waiting()
    const names = treeItems(group).map(itemName)
    // The head, then the questions (newest first), then the tasks.
    expect(names[1]).toMatch(/^Captain for marketing-site asks: Should the launch page go live on Monday/)
    expect(names[2]).toMatch(/^Captain for box-yard asks: Which database should the spike use\?/)
    expect(names.slice(3).join(" | ")).toContain("Check SSH into the bench")
    // Two questions and two tasks: four, amber because they ask.
    expect(group.querySelector(ASKS_AMBER)!.textContent).toBe("4")
    expect(document.title).toBe("(4) Box Yard")
    // A row is a treeitem the arrow keys reach, one level in, with its project's square and the time.
    const row = rows()[0]!
    expect(row.getAttribute("role")).toBe("treeitem")
    expect(row.getAttribute("aria-level")).toBe("2")
    expect(row.textContent).toContain("Captain for marketing-site")
  })

  it("turn the badge amber even when only PRs wait, and count under the cap of five", () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ ...PLAIN, id: `oq_many0000000${i}`, createdAt: now - i * 1000 }))
    const prs = [1, 2, 3].map((n) => task(`task_pr000${n}0`, SITE.id, `PR task ${n}`, "pr_ready"))
    render(APP_HOME, many, prs)
    const group = waiting()
    expect(group.querySelector(ASKS_AMBER)!.textContent).toBe("7")
    // Four questions take four of the five places; one PR task shows, the rest wait behind "Show all 7".
    expect(rows()).toHaveLength(4)
    expect(group.textContent).toContain("PR task 1")
    expect(group.textContent).not.toContain("PR task 2")
    click([...group.querySelectorAll("button")].find((b) => b.textContent === "Show all 7")!)
    expect(waiting().textContent).toContain("PR task 3")
  })

  it("show Waiting on you with questions alone", () => {
    render(APP_HOME, [PLAIN], [])
    expect(waiting().querySelector(ASKS_AMBER)!.textContent).toBe("1")
    expect(rows()).toHaveLength(1)
  })
})

describe("the answer sheet", () => {
  it("opens from a row, says who asks and who filed it, and closes with Back", async () => {
    render()
    click(rows()[1]!.querySelector("button")!)
    expect(askParam()).toBe(SEVERAL.id)
    const s = sheet()!
    expect(s.querySelector("h2")!.textContent).toBe("Captain for box-yard asks")
    expect(s.textContent).toContain("Filed by the Coordinator")
    expect(s.textContent).toContain("Two choices before the spike starts.")
    expect(s.querySelector("[aria-label=Close]")).not.toBeNull()
    act(() => history.back())
    await flush()
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(askParam()).toBeNull()
    expect(sheet()).toBeNull()
  })

  it("opens from ?ask= (a notification's link)", () => {
    render(`/?ask=${PLAIN.id}`)
    expect(sheet()!.querySelector("h2")!.textContent).toBe("Captain for marketing-site asks")
    expect(sheet()!.textContent).toContain("Filed by Box Yard")
  })

  it("several questions: the default picked, an option, an own answer, Back and Next keep them, Send sends them all", async () => {
    render(`/?ask=${SEVERAL.id}`)
    const s = sheet()!
    expect(s.querySelector("[data-testid=ask-progress]")!.textContent).toBe("1 of 2")
    expect(s.querySelector("legend")!.textContent).toContain("Which database should the spike use?")
    expect(checked()).toBe(0)
    // Pick the other option, then Next.
    click(radios()[1]!)
    expect(checked()).toBe(1)
    click(s.querySelector("[data-testid=ask-next]")!)
    expect(sheet()!.querySelector("[data-testid=ask-progress]")!.textContent).toBe("2 of 2")
    // Own answer on the second, then Back: the first kept its pick.
    setValue(sheet()!.querySelector<HTMLInputElement>("[data-testid=ask-custom]")!, "Keep it two releases")
    click(sheet()!.querySelector("[data-testid=ask-back]")!)
    expect(checked()).toBe(1)
    click(sheet()!.querySelector("[data-testid=ask-next]")!)
    expect(sheet()!.querySelector<HTMLInputElement>("[data-testid=ask-custom]")!.value).toBe("Keep it two releases")
    click(sheet()!.querySelector("[data-testid=ask-send]")!)
    await flush()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.url).toBe(`/api/owner-questions/${SEVERAL.id}/answers`)
    expect(posts[0]!.body).toMatchObject({ key: askKey(QUESTIONS), answers: ["SQLite", "Keep it two releases"] })
    await flush()
    // The sheet closes and the row goes.
    expect(askParam()).toBeNull()
    expect(sheet()).toBeNull()
    expect(rows().map((r) => r.dataset.stableKey)).toEqual([PLAIN.id])
  })

  it("a plain question: the Captain's words, one box, Send", async () => {
    render(`/?ask=${PLAIN.id}`)
    const s = sheet()!
    expect(s.querySelector("[data-testid=owner-question-text] strong")!.textContent).toBe("launch page")
    click(s.querySelector("[data-testid=owner-question-send]")!)
    expect(s.querySelector("[data-testid=owner-question-error]")!.textContent).toBe("Type your answer first.")
    expect(posts).toHaveLength(0)
    setValue(s.querySelector<HTMLTextAreaElement>("[data-testid=owner-question-answer]")!, "Wait for the photos.")
    click(s.querySelector("[data-testid=owner-question-send]")!)
    await flush()
    expect(posts[0]!.url).toBe(`/api/owner-questions/${PLAIN.id}/answers`)
    expect(posts[0]!.body).toMatchObject({ key: "plain", answers: ["Wait for the photos."] })
    expect(posts[0]!.body.id).toMatch(/^chat_/)
    await flush()
    expect(sheet()).toBeNull()
  })

  it("Dismiss hides the row at once with Undo; the dismiss goes only after the window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    render(`/?ask=${PLAIN.id}`)
    click(sheet()!.querySelector("[data-testid=owner-question-dismiss]")!)
    expect(askParam()).toBeNull()
    expect(rows().map((r) => r.dataset.stableKey)).toEqual([SEVERAL.id])
    expect(waiting().querySelector(ASKS_AMBER)!.textContent).toBe("3")
    const toast = currentToasts().find((t) => t.action?.label === "Undo")!
    expect(toast.title).toBe("Dismissed the Captain for marketing-site's question")
    act(() => toast.action!.onClick())
    expect(rows()).toHaveLength(2)
    // Again, and let the window pass: now it's sent.
    click(rows().find((r) => r.dataset.stableKey === PLAIN.id)!.querySelector("button")!)
    click(sheet()!.querySelector("[data-testid=owner-question-dismiss]")!)
    expect(posts).toHaveLength(0)
    await act(async () => void vi.advanceTimersByTime(5000))
    vi.useRealTimers()
    await flush()
    expect(posts.map((p) => p.url)).toEqual([`/api/owner-questions/${PLAIN.id}/dismiss`])
  })

  it("says Already answered when another tab answered it, and its row dims", async () => {
    // One this tab never touched (an item answered here leaves the list instead).
    const other = { ...SEVERAL, id: "oq_elsewhere0001" }
    render(`/?ask=${other.id}`, [other, PLAIN])
    act(() => applyOwnerQuestion(qc, { ...other, state: "answered", closedAt: Date.now() }))
    await flush()
    expect(sheet()!.querySelector("[data-testid=owner-question-closed]")!.textContent).toBe("Already answered")
    expect(sheet()!.querySelector("[data-testid=owner-question-dismiss]")).toBeNull()
    expect(rows().find((r) => r.dataset.stableKey === other.id)!.dataset.closed).toBe("true")
    // It no longer counts.
    expect(waiting().querySelector(ASKS_AMBER)!.textContent).toBe("3")
  })

  it("a new question joins the list at the top", async () => {
    render(APP_HOME, [SEVERAL])
    act(() => applyOwnerQuestion(qc, PLAIN))
    await flush()
    expect(rows().map((r) => r.dataset.stableKey)).toEqual([PLAIN.id, SEVERAL.id])
  })
})

describe("on a phone", () => {
  it("the menu button counts the questions, the drawer lists them first, and a row opens the sheet over it", () => {
    viewport(390, 844)
    render()
    const menu = $<HTMLButtonElement>("[data-testid=chat-panel] header button[aria-label^='Projects and tasks']")!
    expect(menu.getAttribute("aria-label")).toBe("Projects and tasks, 4 waiting on you")
    expect(menu.querySelector(ASKS_AMBER)!.textContent).toBe("4")
    click(menu)
    const drawer = $("[role=dialog][aria-label='Projects and tasks']")!
    const first = drawer.querySelector<HTMLElement>("[data-testid=owner-question-row]")!
    expect(first.dataset.stableKey).toBe(PLAIN.id)
    click(first.querySelector("button")!)
    const s = sheet()!
    expect(s.className).toContain("max-sm:rounded-t-2xl")
    expect(s.querySelector("[data-testid=owner-question-answer]")).not.toBeNull()
  })
})
