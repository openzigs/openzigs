export { TemplateRepository } from "./template-repository.js";
export { TemplateService, extractVariables, interpolateTemplate } from "./template-service.js";
export type {
  OrchestrationTemplate,
  CreateOrchestrationTemplateInput,
  UpdateOrchestrationTemplateInput,
  ExecuteTemplateInput,
  StageAgent,
  OrchestrationStage,
  TemplateVariable,
  TemplateCategory,
} from "./types.js";
export {
  CreateOrchestrationTemplateSchema,
  UpdateOrchestrationTemplateSchema,
  ExecuteTemplateSchema,
  StageAgentSchema,
  OrchestrationStageSchema,
  TemplateVariableSchema,
  TemplateCategorySchema,
} from "./types.js";
