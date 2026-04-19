export { CanvasClient, CanvasApiError } from './canvas/client.js'
export { ConfigManager } from './config/manager.js'
export type { CanvasTeacherConfig } from './config/schema.js'
export { SecureStore } from './security/secure-store.js'
export { SidecarManager } from './security/sidecar-manager.js'
export { registerContextTools } from './tools/context.js'

// canvas API functions
export * from './canvas/assignments.js'
export * from './canvas/quizzes.js'
export * from './canvas/pages.js'
export * from './canvas/modules.js'
export * from './canvas/discussions.js'
export * from './canvas/files.js'
export * from './canvas/rubrics.js'
export * from './canvas/courses.js'
export * from './canvas/search.js'
// submissions — explicit to avoid name collision with CanvasAssignmentGroup from assignments.ts
export {
  type CanvasSubmission,
  type CanvasEnrollment,
  type CanvasAssignment,
  fetchStudentEnrollments,
  fetchTeacherSectionIds,
  fetchAllSubmissions,
  fetchStudentSubmissions,
  fetchAssignmentSubmissions,
  fetchAssignment,
  fetchAssignmentGroups,
  gradeSubmission,
} from './canvas/submissions.js'

// template system
export * from './templates/index.js'
export { seedDefaultTemplates } from './templates/seed.js'

// matching utilities
export * from './matching/index.js'

// attendance
export * from './attendance/index.js'

// roster
export * from './roster/index.js'
