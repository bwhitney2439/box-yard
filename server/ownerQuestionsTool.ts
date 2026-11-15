// The Coordinator's ask_owner tool (docs/specs/inbox-owner-questions.md §6): it puts a Captain's question for Cody in
// Cody's Inbox as a form, the same several-questions shape as ask_user. server/mcp.ts registers it Coordinator-only;
// OwnerQuestions.file does the checking, filing, grouping and notifying.

import { z } from "zod"
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js"
import { MAX_OPTIONS, MAX_QUESTION_TEXT, MAX_QUESTIONS } from "../shared/askQuestions.js"
import type { Project } from "../shared/types.js"
import type { OwnerQuestions } from "./ownerQuestions.js"
import { errorMessage } from "./util/retry.js"

export interface AskOwnerHelpers {
  /** The MCP server's project resolver: throws for an unknown project (or, for a Captain, another one). */
  project: (ref: string) => Project
  /** Throws when the project is status only for this caller (docs/identities.md). */
  unsealed: (projectId: string, what: string) => void
  /** withOwner with the configured owner name, for Box Yard's own words in the result. */
  owner: (text: string) => string
  ownerQuestions?: OwnerQuestions
}

// The description and top-level parameter descriptions say "Cody": nameOwnerInTools (server/mcp.ts) puts the owner's name in.
export const ASK_OWNER_DESCRIPTION =
  "Coordinator tool: put a Captain's question for Cody in Cody's Inbox, as a form with your recommended answer and the " +
  "other options for each question. Use it for every question or decision only Cody can make that a Captain sent you, " +
  "instead of asking in your reply, where newer messages hide it. One call per project: group that Captain's related " +
  "questions (up to 10). Don't file what you can answer yourself: send_to_captain the answer instead. Cody's answer " +
  'comes back to you as a message starting "[Inbox answer oq_…]"; pass it on with send_to_captain.'

type Args = { project: string; question?: string; questions: { question: string; default_answer: string; options?: string[] }[] }

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
})

export function registerAskOwner(server: McpServer, h: AskOwnerHelpers): RegisteredTool {
  return server.registerTool(
    "ask_owner",
    {
      description: ASK_OWNER_DESCRIPTION,
      inputSchema: {
        project: z.string().describe("Project id or name: whose Captain asked"),
        question: z.string().max(MAX_QUESTION_TEXT).optional().describe("One or two lines of context shown above the questions"),
        questions: z
          .array(
            z.object({
              question: z.string().describe("The question, in Markdown"),
              default_answer: z.string().describe("Your recommended answer, pre-selected"),
              // Nested, so nameOwnerInTools doesn't reach it.
              options: z.array(z.string()).max(MAX_OPTIONS).optional().describe(h.owner("The other answers worth offering. Cody can always type their own.")),
            }),
          )
          .min(1)
          .max(MAX_QUESTIONS),
      },
    },
    async (a: Args) => {
      try {
        if (!h.ownerQuestions) return text(h.owner("Cody's Inbox questions are not available in this Box Yard process."), true)
        const p = h.project(a.project)
        // A status-only project's Captain files its own questions and gets the answer straight back: the Coordinator
        // never sees them (decision 4), so it can't file one for it either.
        h.unsealed(p.id, h.owner("its Captain puts its questions in Cody's Inbox itself, and Cody's answer goes straight back to it"))
        const { question, duplicate, grouped } = h.ownerQuestions.file({ projectId: p.id, question: a.question, questions: a.questions })
        return text({
          filed: question.id,
          project: p.name,
          questions: question.questions?.length ?? 1,
          groupedCaptainQuestions: grouped,
          duplicate,
          next: h.owner(
            `It's in Cody's Inbox. Tell Cody in one line; don't ask the same thing in your reply. The answer comes to you as a message starting [Inbox answer ${question.id}].`,
          ),
        })
      } catch (err) {
        return text(errorMessage(err), true)
      }
    },
  )
}
