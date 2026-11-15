// The Inbox questions' REST routes (docs/specs/inbox-owner-questions.md › The API). Mounted on the signed-in API
// router, so only the owner answers or dismisses: no MCP tool does.

import type { Router } from "express"
import { z } from "zod"
import { MAX_ANSWER_TEXT, MAX_QUESTIONS } from "../shared/askQuestions.js"
import { BadRequestError } from "./store.js"
import type { OwnerQuestions } from "./ownerQuestions.js"

const answerBody = z.object({
  /** The client's message id: a double tap sends once. */
  id: z.string().regex(/^[a-z]+_[A-Za-z0-9-]{6,40}$/).optional(),
  key: z.string().min(1).max(40),
  answers: z.array(z.string().max(MAX_ANSWER_TEXT)).min(1).max(MAX_QUESTIONS),
})

export function ownerQuestionRoutes(api: Router, ownerQuestions: OwnerQuestions) {
  api.get("/owner-questions", (_req, res) => {
    res.json(ownerQuestions.listOpen())
  })
  api.post("/owner-questions/:id/answers", (req, res) => {
    const body = answerBody.safeParse(req.body)
    if (!body.success) throw new BadRequestError(body.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "))
    res.json(ownerQuestions.answer(req.params.id!, body.data.key, body.data.answers, body.data.id))
  })
  api.post("/owner-questions/:id/dismiss", (req, res) => {
    res.json(ownerQuestions.dismiss(req.params.id!))
  })
}
