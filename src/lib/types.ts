// الأنواع المشتركة للمشروع — MCP Media Generator
// المزودان المدعمان للتوليد + خدمة الدمج
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type KeyStatus = "active" | "exhausted" | "disabled";

// فئات الأخطاء الموحدة (قسم 4.2 من المواصفة)
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export interface Attempt {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: MediaType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  // حقول محسوبة للراحة
  params?: Record<string, unknown>;
  result_urls?: string[];
  attempts?: Attempt[];
}

export interface KeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

// نتيجة فحص حالة مهمة لدى المزود
export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number;
}

// واجهة المزودات (قسم 5.2 من المواصفة)
export interface ProviderAdapter {
  id: ProviderId;
  // مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId
  createTask(key: KeyRow, model: string, input: Record<string, unknown>): Promise<{ providerTaskId: string }>;
  // صور متزامنة إن كان المزود يدعمها (CometAPI تعيد النتيجة فورًا)
  createImageSync?(key: KeyRow, input: Record<string, unknown>): Promise<{ urls: string[] }>;
  // استعلام حالة مهمة جارية
  checkTask(key: KeyRow, providerTaskId: string): Promise<CheckResult>;
}

// نتيجة استدعاء أداة MCP
export interface ToolResponse {
  text: string;
  isError?: boolean;
}

export interface ProgressNotifier {
  (progress: number, total: number, message: string): Promise<void>;
}
