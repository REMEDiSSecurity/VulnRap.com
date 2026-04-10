import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { userFeedbackTable } from "@workspace/db";
import { SubmitFeedbackBody } from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/feedback", async (req, res) => {
  try {
    const parsed = SubmitFeedbackBody.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({ error: "Invalid feedback data. Rating (1-5) and helpful (true/false) are required." });
      return;
    }

    const { reportId, rating, helpful, comment } = parsed.data;

    const trimmedComment = comment?.trim().slice(0, 1000) || null;

    const [inserted] = await db
      .insert(userFeedbackTable)
      .values({
        reportId: reportId ?? null,
        rating,
        helpful,
        comment: trimmedComment,
      })
      .returning({ id: userFeedbackTable.id });

    res.status(201).json({
      id: inserted.id,
      message: "Thank you for your feedback!",
    });
  } catch (err) {
    req.log?.error(err, "Failed to submit feedback");
    res.status(500).json({ error: "Failed to submit feedback." });
  }
});

export default router;
