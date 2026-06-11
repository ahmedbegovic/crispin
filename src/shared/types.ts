export type Tier = 'low' | 'medium' | 'high' | 'extraHigh' | 'ultra'

export type Feature = 'chat' | 'agent' | 'code' | 'research' | 'news'

export type ProcessName = 'tools' | 'engine' | (string & {})

export type ProcessState =
  | 'stopped'
  | 'spawning'
  | 'waiting_healthy'
  | 'running'
  | 'unhealthy'
  | 'restarting'
  | 'failed'

export interface ProcessSnapshot {
  name: ProcessName
  state: ProcessState
  port: number | null
  pid: number | null
  /** Human-readable detail, e.g. last error or restart reason. */
  detail?: string
}

export interface SystemStatus {
  version: string
  dataDir: string
  processes: ProcessSnapshot[]
}

// ---------------------------------------------------------------------------
// Models / engine (M1)
// ---------------------------------------------------------------------------

/** Lifecycle of one model inside the oMLX engine. */
export type EngineModelState = 'unloaded' | 'loading' | 'loaded'

export interface EngineModelInfo {
  id: string
  state: EngineModelState
  /** Estimated or measured footprint, GB; null when unknown. */
  memoryGB: number | null
}

export interface EngineStatus {
  running: boolean
  budgetGB: number | null
  models: EngineModelInfo[]
}

/**
 * The model's own recommended sampling, from its generation_config.json.
 * All three are sent per request — oMLX plumbs top_k, so gemma's
 * recommended top_k 64 finally applies.
 */
export interface ModelSampling {
  temperature: number | null
  topP: number | null
  topK: number | null
}

/** A model snapshot present in the shared HF cache. */
export interface InstalledModel {
  repoId: string
  sizeBytes: number
  lastModifiedAt: number | null
  /** max_position_embeddings from the snapshot's config.json; null if unreadable. */
  contextLength: number | null
  sampling: ModelSampling | null
}

export type DownloadState = 'queued' | 'downloading' | 'done' | 'failed' | 'cancelled'

export interface DownloadInfo {
  id: string
  repoId: string
  status: DownloadState
  bytesDone: number
  bytesTotal: number | null
  error: string | null
  startedAt: number
  finishedAt: number | null
}

export interface HFSearchResult {
  repoId: string
  downloads: number
  likes: number
  updatedAt: number | null
  /** Set when the repo fails the QAT/PLE validator. */
  warning: string | null
}

export type CatalogFamily = 'gemma' | 'qwen' | 'experimental'
export type ModelFit = 'perfect' | 'good' | 'risky' | 'unable'

export interface TierCandidateInfo {
  repoId: string
  installed: boolean
  engineState: EngineModelState | null
  /** Grid column: curated brand or Experimental (HF-downloaded). */
  family: CatalogFamily
  /** Estimated load footprint, GB. */
  estGB: number
  fit: ModelFit
}

export interface TierResolution {
  tier: Tier
  candidates: TierCandidateInfo[]
  /** First installed candidate — what this tier resolves to today. */
  active: string | null
}

export interface RamReport {
  totalGB: number
  freeGB: number
  /** vm_stat-derived available memory (free+inactive+purgeable+speculative); null when sampling fails. */
  availableGB: number | null
  /** Engine registry memory budget. */
  budgetGB: number
  /** Sum of estimated footprints of currently loaded engine models. */
  loadedGB: number
}

export type FeatureDefaults = Record<Feature, Tier>

export interface ModelsOverview {
  engine: EngineStatus
  installed: InstalledModel[]
  downloads: DownloadInfo[]
  tiers: TierResolution[]
  defaults: FeatureDefaults
  /** Per-tier explicit model picks (Settings-backed); resolution honors them. */
  tierSelections: Partial<Record<Tier, string>>
  ram: RamReport
}

// ---------------------------------------------------------------------------
// Chat (M2)
// ---------------------------------------------------------------------------

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** One web/RAG source behind a [n] citation. */
export interface SourceRef {
  id: number
  title: string | null
  url: string
}

/**
 * Message content is an ordered list of parts; assistant text streams into a
 * text part, gemma thought channels land in a thought part, tool round-trips
 * in tool_call/tool_result pairs. Persisted as JSON in messages.parts.
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thought'; text: string }
  | { type: 'image'; path: string; mime: string }
  /** args is the raw JSON string from the model — kept raw so malformed calls are inspectable. */
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'tool_result'; toolCallId: string; name: string; result: string; sourceIds?: number[] }
  | { type: 'sources'; sources: SourceRef[] }

export interface Conversation {
  id: string
  title: string
  systemPrompt: string | null
  headMessageId: string | null
  defaultTier: Tier
  collectionId: string | null
  webEnabled: boolean
  archived: boolean
  createdAt: number
  updatedAt: number
}

export interface ConversationMeta {
  id: string
  title: string
  archived: boolean
  updatedAt: number
}

export interface ChatMessage {
  id: string
  conversationId: string
  parentId: string | null
  role: MessageRole
  parts: MessagePart[]
  modelId: string | null
  tokensIn: number | null
  tokensOut: number | null
  createdAt: number
  /** Position among the parent's children — drives the BranchSwitcher. */
  siblingIndex: number
  siblingCount: number
  /** All sibling message ids in branch order (includes this message). */
  siblingIds: string[]
}

export interface AttachmentInput {
  path: string
  kind: 'image' | 'document'
}

// ---------------------------------------------------------------------------
// Library / RAG (M2)
// ---------------------------------------------------------------------------

export interface Collection {
  id: string
  name: string
  kind: 'library' | 'notebook'
  docCount: number
  createdAt: number
}

export type LibraryDocStatus = 'pending' | 'ingesting' | 'ready' | 'failed'

export interface LibraryDoc {
  id: string
  collectionId: string
  title: string | null
  /** File path or URL the doc came from. */
  source: string
  kind: string
  status: LibraryDocStatus
  error: string | null
  chunkCount: number
  createdAt: number
}

// ---------------------------------------------------------------------------
// MCP / skills (M2)
// ---------------------------------------------------------------------------

export type McpTransport = 'stdio' | 'http'
export type McpScope = 'chat' | 'agent' | 'both'

export interface McpServer {
  id: string
  name: string
  transport: McpTransport
  command: string | null
  args: string[]
  url: string | null
  env: Record<string, string>
  enabled: boolean
  scope: McpScope
}

export interface SkillMeta {
  name: string
  description: string
  /** True when the skill is symlinked into opencode (Agent/Code tabs). */
  agentEnabled: boolean
}

/** Which UI surface owns an opencode session. */
export type AgentTab = 'agent' | 'code'

export interface AgentSessionMeta {
  id: string
  tab: AgentTab
  directory: string
  title: string | null
  createdAt: number
  lastUsedAt: number | null
}

/** One node of a lazy directory listing inside a code workspace. */
export interface WorkspaceEntry {
  name: string
  /** Workspace-relative path, '/'-separated. */
  path: string
  kind: 'file' | 'dir'
}

export type ResearchMode = 'standard' | 'heavy'
export type ResearchStatus =
  | 'planning'
  | 'rounds'
  | 'synthesis'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'paused'
export type ResearchStepType =
  | 'plan'
  | 'search'
  | 'select'
  | 'visit'
  | 'note'
  | 'sufficiency'
  | 'synthesis'
  | 'render'
export type ResearchStepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface ResearchRunMeta {
  id: string
  question: string
  mode: ResearchMode
  status: ResearchStatus
  round: number
  collectionId: string | null
  tier: Tier | null
  reportPath: string | null
  createdAt: number
  finishedAt: number | null
}

export interface ResearchStep {
  id: string
  runId: string
  round: number
  seq: number
  type: ResearchStepType
  status: ResearchStepStatus
  /** Step-specific JSON; renderer casts per type. */
  input: unknown
  output: unknown
  startedAt: number | null
  finishedAt: number | null
}

export interface ResearchSource {
  id: string
  url: string
  title: string | null
  fetched: boolean
  cited: boolean
}

export interface NewsSource {
  id: string
  url: string
  title: string | null
  enabled: boolean
  lastFetchedAt: number | null
}

export type NewsItemStatus = 'new' | 'extracting' | 'pending_summary' | 'summarized' | 'failed'

/** List-shaped item — the extracted article body is fetched per-item. */
export interface NewsItem {
  id: string
  sourceId: string
  sourceTitle: string | null
  url: string | null
  title: string | null
  publishedAt: number | null
  summary: string | null
  status: NewsItemStatus
  readAt: number | null
  createdAt: number
}
