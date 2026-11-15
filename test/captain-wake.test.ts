import { describe, expect, it } from "vitest"
import { FYI_MARKER, captainReplyWakes, mustWake, takeFyiMarker } from "../server/captainWake.js"
import { ORCHESTRATOR_PROMPT, captainPrompt } from "../server/prompts.js"
import { OWNER_QUESTION_MARKER, takeOwnerQuestionMarker } from "../shared/ownerQuestions.js"
import { withOwner } from "../shared/owner.js"
import type { Project } from "../shared/types.js"

describe("takeFyiMarker", () => {
  it("strips the hidden line and says it was there", () => {
    expect(takeFyiMarker(`All 3 tasks are working.\n\n${FYI_MARKER}`)).toEqual({ text: "All 3 tasks are working.", fyi: true })
    expect(takeFyiMarker("All 3 tasks are working.\n<!--boxyard-coordinator:FYI-->\n")).toEqual({ text: "All 3 tasks are working.", fyi: true })
  })

  it("keeps a next-steps block after it for the chips", () => {
    const r = takeFyiMarker(`Started task X.\n\n${FYI_MARKER}\n\n<!-- boxyard-next-steps\n["Check it"]\n-->`)
    expect(r.fyi).toBe(true)
    expect(r.text).toBe('Started task X.\n\n<!-- boxyard-next-steps\n["Check it"]\n-->')
  })

  it("leaves text without the marker alone", () => {
    expect(takeFyiMarker("  Done.\n")).toEqual({ text: "  Done.\n", fyi: false })
  })
})

describe("takeOwnerQuestionMarker", () => {
  it("strips the hidden line and says it was there", () => {
    expect(takeOwnerQuestionMarker(`Ship it today? I'd say yes.\n\n${OWNER_QUESTION_MARKER}`)).toEqual({ text: "Ship it today? I'd say yes.", asked: true })
    expect(takeOwnerQuestionMarker("Ship it today?\n<!--Boxyard-Owner-Question-->\n")).toEqual({ text: "Ship it today?", asked: true })
  })

  it("comes off with the FYI line, and keeps a next-steps block for the chips", () => {
    const fyi = takeFyiMarker(`Ship it today?\n\n${OWNER_QUESTION_MARKER}\n${FYI_MARKER}\n\n<!-- boxyard-next-steps\n["Answer it"]\n-->`)
    const r = takeOwnerQuestionMarker(fyi.text)
    expect({ fyi: fyi.fyi, asked: r.asked }).toEqual({ fyi: true, asked: true })
    expect(r.text).toBe('Ship it today?\n\n<!-- boxyard-next-steps\n["Answer it"]\n-->')
  })

  it("leaves text without the marker alone", () => {
    expect(takeOwnerQuestionMarker("  Done.\n")).toEqual({ text: "  Done.\n", asked: false })
    expect(takeOwnerQuestionMarker(`Done.\n${FYI_MARKER}`).asked).toBe(false)
  })
})

describe("mustWake", () => {
  it("lets a plain status through", () => {
    expect(mustWake("[Fix the login bug](/tasks/task_abc123) is working; PR #12 is open and merged into main.")).toBeNull()
    expect(mustWake("Started 3 tasks: see https://github.com/acme/app/pull/12?tab=files and `fix-error-page`.")).toBeNull()
  })

  it("wakes on a question, a failure or a decision", () => {
    expect(mustWake("Should it go out today?")).toMatch(/asks/)
    expect(mustWake("The build failed on the deploy step.")).toMatch(/failure/)
    expect(mustWake("Task X is stuck on a merge conflict.")).toMatch(/failure/)
    expect(mustWake("It couldn't push the branch.")).toMatch(/failure/)
    expect(mustWake("PR #3 is ready and waiting for your approval.")).toMatch(/decision/)
    expect(mustWake("Cody needs to pick a name.", "Cody")).toMatch(/Cody/)
  })

  it("reads the owner's name", () => {
    expect(mustWake("Sam has to pick a name.", "Sam")).toMatch(/Sam/)
    expect(mustWake("Sam's demo is live.", "Sam")).toBeNull()
  })
})

describe("captainReplyWakes", () => {
  const fyi = { ok: true, text: "Task X is working.", fyi: true }
  it("skips the wake only for an FYI reply nothing else needs", () => {
    expect(captainReplyWakes(fyi)).toEqual({ wake: false, why: "FYI" })
  })

  it("wakes when unsure", () => {
    expect(captainReplyWakes({ ...fyi, fyi: false }).wake).toBe(true)
    expect(captainReplyWakes({ ...fyi, ok: false }).wake).toBe(true)
    expect(captainReplyWakes({ ...fyi, coordinatorWaits: true }).wake).toBe(true)
    expect(captainReplyWakes({ ...fyi, text: "Task X failed." }).wake).toBe(true)
  })
})

describe("the Captain's prompt", () => {
  const project = { id: "prj_demo01", name: "demo", repo: null, baseBranch: "main", description: "" } as unknown as Project
  it("says how to mark an FYI reply", () => {
    expect(captainPrompt(project)).toContain(FYI_MARKER)
  })

  it("sends a question for the owner up to the Coordinator with the owner-question line, never as an FYI", () => {
    const text = captainPrompt(project, "Ada")
    expect(text).toContain(
      `Questions for Ada: any question or decision only Ada can make goes up to the Coordinator, never only in your own chat, even when Ada is talking to you here (they may have left). Ask it in your reply as a short, self-contained question with your recommended answer and the other options, and end the reply with this hidden line on its own: ${OWNER_QUESTION_MARKER}. Box Yard then sends the reply to the Coordinator, which puts it in Ada's Inbox and passes the answer back to you. Never mark such a reply FYI. Questions you can settle yourself don't need the line.`,
    )
    // Right after the FYI line.
    expect(text.indexOf("Questions for Ada:")).toBeGreaterThan(text.indexOf(FYI_MARKER))
    expect(text).not.toMatch(/\bCody\b/)
    expect(text).not.toContain("straight to Ada's Inbox")
  })
})

describe("the Coordinator's prompt", () => {
  it("files Captains' questions for the owner with ask_owner, before the other tools", () => {
    const text = withOwner(ORCHESTRATOR_PROMPT, "Ada")
    expect(text).toContain(
      `Questions for Ada from Captains: when a Captain's reply holds a question or decision only Ada can make, put it in Ada's Inbox with ask_owner, never only as text in your reply, where newer messages hide it.`,
    )
    expect(text).toContain(`Ada's answer comes back to you as a message starting "[Inbox answer oq_…]" with the question, the answer and the Captain it's for: pass it to that Captain with send_to_captain in the same turn, adding any context it needs.\n\nOther tools: relay agents' questions to Ada plainly`)
  })
})
