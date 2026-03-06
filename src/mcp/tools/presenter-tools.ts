import * as z from "zod";
import type { ToolDefinition } from "../tool-registry.js";
import type { PresentationRepository } from "../../presenter/presentation-repository.js";
import type { QuizGenerator } from "../../presenter/quiz-generator.js";
import type { TeacherAgent } from "../../presenter/teacher-agent.js";

const managePresentationsSchema = z.object({
  action: z.enum(["list", "get", "delete", "generate_quiz", "ask_question"]),
  id: z.string().optional().describe("Presentation ID"),
  question: z.string().optional().describe("Question for Teacher Agent"),
  chapter_index: z.number().optional().describe("Chapter index context"),
  timestamp: z.number().optional().describe("Video timestamp in seconds"),
});

export type PresenterToolsOptions = {
  presentationRepo: PresentationRepository;
  quizGenerator: QuizGenerator;
  teacherAgent: TeacherAgent;
};

export const createPresenterTools = ({
  presentationRepo,
  quizGenerator,
  teacherAgent,
}: PresenterToolsOptions): ToolDefinition[] => {
  return [
    {
      name: "manage-presentations",
      description:
        "Manage interactive Presenter Mode. List/get presentations, generate quizzes per chapter, and ask the Teacher Agent questions using RAG.",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "delete", "generate_quiz", "ask_question"] },
          id: { type: "string" },
          question: { type: "string" },
          chapter_index: { type: "number" },
          timestamp: { type: "number" },
        },
        required: ["action"],
      },
      zodSchema: managePresentationsSchema,
      category: "knowledge",
      riskLevel: "low",
      handler: async (args) => {
        try {
          const input = managePresentationsSchema.parse(args);

          switch (input.action) {
            case "list": {
              const all = presentationRepo.listAll();
              return { text: JSON.stringify({ count: all.length, presentations: all }, null, 2) };
            }
            case "get": {
              if (!input.id) return { text: "'id' is required.", isError: true };
              const pres = presentationRepo.findById(input.id);
              if (!pres) return { text: `Presentation '${input.id}' not found.`, isError: true };
              return { text: JSON.stringify(pres, null, 2) };
            }
            case "delete": {
              if (!input.id) return { text: "'id' is required.", isError: true };
              const deleted = presentationRepo.delete(input.id);
              if (!deleted) return { text: `Presentation '${input.id}' not found.`, isError: true };
              return { text: `Presentation '${input.id}' deleted.` };
            }
            case "generate_quiz": {
              if (!input.id) return { text: "'id' is required.", isError: true };
              const quizzes = await quizGenerator.generate(input.id);
              return { text: JSON.stringify({ count: quizzes.length, quizzes }, null, 2) };
            }
            case "ask_question": {
              if (!input.id || !input.question) {
                return { text: "'id' and 'question' are required.", isError: true };
              }
              let answer = "";
              for await (const chunk of teacherAgent.ask({
                presentationId: input.id,
                question: input.question,
                chapterIndex: input.chapter_index ?? 0,
                timestamp: input.timestamp ?? 0,
              })) {
                answer += chunk;
              }
              return { text: answer };
            }
            default:
              return { text: `Unknown action: ${input.action}`, isError: true };
          }
        } catch (err) {
          return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      },
    },
  ];
};
