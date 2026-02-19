/**
 * Presenter Mode — PDF Recap Generator (client-side)
 * Issue #280 (SI-5): Uses jsPDF + jspdf-autotable.
 */

import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { QuizResult, QAEntry } from "@/hooks/use-presenter-state";

interface RecapData {
  title: string;
  quizResults: QuizResult[];
  qaHistory: QAEntry[];
  score: { correct: number; total: number; pct: number } | null;
}

export function generateRecapPdf({ title, quizResults, qaHistory, score }: RecapData) {
  const doc = new jsPDF();

  // Title
  doc.setFontSize(20);
  doc.text("Session Recap", 14, 22);
  doc.setFontSize(12);
  doc.text(title, 14, 32);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated ${new Date().toLocaleString()}`, 14, 40);
  doc.setTextColor(0);

  let y = 50;

  // Score summary
  if (score) {
    doc.setFontSize(14);
    doc.text(`Score: ${score.pct}% (${score.correct}/${score.total})`, 14, y);
    y += 12;
  }

  // Quiz results table
  if (quizResults.length > 0) {
    doc.setFontSize(14);
    doc.text("Quiz Results", 14, y);
    y += 4;

    autoTable(doc, {
      startY: y,
      head: [["#", "Question", "Result", "Explanation"]],
      body: quizResults.map((r, i) => [
        String(i + 1),
        r.question,
        r.correct ? "Correct" : "Incorrect",
        r.explanation,
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles: {
        0: { cellWidth: 10 },
        1: { cellWidth: 60 },
        2: { cellWidth: 25 },
        3: { cellWidth: "auto" },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable?.finalY ?? y + 40;
    y += 10;
  }

  // Q&A Transcript
  if (qaHistory.length > 0) {
    if (y > 240) {
      doc.addPage();
      y = 20;
    }
    doc.setFontSize(14);
    doc.text("Questions & Answers", 14, y);
    y += 4;

    autoTable(doc, {
      startY: y,
      head: [["Question", "Answer"]],
      body: qaHistory.map((qa) => [
        qa.question,
        qa.answer.length > 300 ? qa.answer.slice(0, 300) + "…" : qa.answer,
      ]),
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [59, 130, 246] },
      columnStyles: {
        0: { cellWidth: 60 },
        1: { cellWidth: "auto" },
      },
    });
  }

  // Download
  const filename = `${title.toLowerCase().replace(/\s+/g, "-")}-recap.pdf`;
  doc.save(filename);
}
