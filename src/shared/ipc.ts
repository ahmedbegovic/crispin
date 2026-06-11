import { z } from 'zod'

// ---------------------------------------------------------------------------
// Schemas shared by methods and events
// ---------------------------------------------------------------------------

export const processStateSchema = z.enum([
  'stopped',
  'spawning',
  'waiting_healthy',
  'running',
  'unhealthy',
  'restarting',
  'failed'
])

export const processSnapshotSchema = z.object({
  name: z.string(),
  state: processStateSchema,
  port: z.number().nullable(),
  pid: z.number().nullable(),
  detail: z.string().optional()
})

export const systemStatusSchema = z.object({
  version: z.string(),
  dataDir: z.string(),
  processes: z.array(processSnapshotSchema)
})

export const tierSchema = z.enum(['low', 'medium', 'high', 'extraHigh', 'ultra'])
export const featureSchema = z.enum(['chat', 'agent', 'code', 'research', 'news'])

export const engineModelStateSchema = z.enum(['unloaded', 'loading', 'loaded'])

export const engineModelInfoSchema = z.object({
  id: z.string(),
  state: engineModelStateSchema,
  memoryGB: z.number().nullable()
})

export const engineStatusSchema = z.object({
  running: z.boolean(),
  budgetGB: z.number().nullable(),
  models: z.array(engineModelInfoSchema)
})

export const installedModelSchema = z.object({
  repoId: z.string(),
  sizeBytes: z.number(),
  lastModifiedAt: z.number().nullable(),
  /** max_position_embeddings from the snapshot's config.json; null if unreadable. */
  contextLength: z.number().nullable(),
  /** Recommended sampling from generation_config.json; null if absent. */
  sampling: z
    .object({
      temperature: z.number().nullable(),
      topP: z.number().nullable(),
      topK: z.number().nullable()
    })
    .nullable()
})

export const downloadStateSchema = z.enum(['queued', 'downloading', 'done', 'failed', 'cancelled'])

export const downloadInfoSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  status: downloadStateSchema,
  bytesDone: z.number(),
  bytesTotal: z.number().nullable(),
  error: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable()
})

export const hfSearchResultSchema = z.object({
  repoId: z.string(),
  downloads: z.number(),
  likes: z.number(),
  updatedAt: z.number().nullable(),
  warning: z.string().nullable()
})

export const catalogFamilySchema = z.enum(['gemma', 'qwen', 'experimental'])
export const modelFitSchema = z.enum(['perfect', 'good', 'risky', 'unable'])

export const tierCandidateSchema = z.object({
  repoId: z.string(),
  installed: z.boolean(),
  engineState: engineModelStateSchema.nullable(),
  /** Grid column: curated brand or Experimental (HF-downloaded). */
  family: catalogFamilySchema,
  /** Estimated load footprint, GB. */
  estGB: z.number(),
  fit: modelFitSchema
})

export const tierResolutionSchema = z.object({
  tier: tierSchema,
  candidates: z.array(tierCandidateSchema),
  active: z.string().nullable()
})

export const ramReportSchema = z.object({
  totalGB: z.number(),
  freeGB: z.number(),
  /** vm_stat-derived available memory (free+inactive+purgeable+speculative); null when sampling fails. */
  availableGB: z.number().nullable(),
  budgetGB: z.number(),
  loadedGB: z.number()
})

export const featureDefaultsSchema = z.object({
  chat: tierSchema,
  agent: tierSchema,
  code: tierSchema,
  research: tierSchema,
  news: tierSchema
})

export const modelsOverviewSchema = z.object({
  engine: engineStatusSchema,
  installed: z.array(installedModelSchema),
  downloads: z.array(downloadInfoSchema),
  tiers: z.array(tierResolutionSchema),
  defaults: featureDefaultsSchema,
  /** Per-tier explicit model picks (Settings-backed); resolution honors them. */
  tierSelections: z.partialRecord(tierSchema, z.string()),
  ram: ramReportSchema
})

// --- chat (M2) -------------------------------------------------------------

export const messageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool'])

export const sourceRefSchema = z.object({
  id: z.number(),
  title: z.string().nullable(),
  url: z.string()
})

export const messagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thought'), text: z.string() }),
  z.object({ type: z.literal('image'), path: z.string(), mime: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), args: z.string() }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    name: z.string(),
    result: z.string(),
    sourceIds: z.array(z.number()).optional()
  }),
  z.object({ type: z.literal('sources'), sources: z.array(sourceRefSchema) })
])

export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  systemPrompt: z.string().nullable(),
  headMessageId: z.string().nullable(),
  defaultTier: tierSchema,
  collectionId: z.string().nullable(),
  webEnabled: z.boolean(),
  archived: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number()
})

export const conversationMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  archived: z.boolean(),
  updatedAt: z.number()
})

export const chatMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  parentId: z.string().nullable(),
  role: messageRoleSchema,
  parts: z.array(messagePartSchema),
  modelId: z.string().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  createdAt: z.number(),
  siblingIndex: z.number(),
  siblingCount: z.number(),
  siblingIds: z.array(z.string())
})

export const attachmentInputSchema = z.object({
  path: z.string(),
  kind: z.enum(['image', 'document'])
})

/** chat.get / chat.switchBranch both return the conversation + active path. */
export const conversationViewSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(chatMessageSchema),
  /**
   * Context window of the conversation's current tier's active model — the
   * denominator for the composer's context-usage donut. Null when nothing
   * is installed for the tier.
   */
  contextLength: z.number().nullable()
})

// --- library / RAG (M2) -----------------------------------------------------

export const collectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['library', 'notebook']),
  docCount: z.number(),
  createdAt: z.number()
})

export const libraryDocStatusSchema = z.enum(['pending', 'ingesting', 'ready', 'failed'])

export const libraryDocSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  title: z.string().nullable(),
  source: z.string(),
  kind: z.string(),
  status: libraryDocStatusSchema,
  error: z.string().nullable(),
  chunkCount: z.number(),
  createdAt: z.number()
})

// --- MCP / skills (M2) --------------------------------------------------------

export const mcpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(['stdio', 'http']),
  command: z.string().nullable(),
  args: z.array(z.string()),
  url: z.string().nullable(),
  env: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  scope: z.enum(['chat', 'agent', 'both'])
})

export const skillMetaSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** True when the skill is symlinked into opencode (Agent/Code tabs). */
  agentEnabled: z.boolean()
})

/** Which UI surface owns an opencode session. */
export const agentTabSchema = z.enum(['agent', 'code'])

export const agentSessionMetaSchema = z.object({
  id: z.string(),
  tab: agentTabSchema,
  directory: z.string(),
  title: z.string().nullable(),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable()
})

/** One node of a lazy directory listing inside a code workspace. */
export const workspaceEntrySchema = z.object({
  name: z.string(),
  /** Workspace-relative path, '/'-separated. */
  path: z.string(),
  kind: z.enum(['file', 'dir'])
})

export const researchModeSchema = z.enum(['standard', 'heavy'])
export const researchStatusSchema = z.enum([
  'planning',
  'rounds',
  'synthesis',
  'done',
  'failed',
  'cancelled',
  'paused'
])

export const researchRunMetaSchema = z.object({
  id: z.string(),
  question: z.string(),
  mode: researchModeSchema,
  status: researchStatusSchema,
  round: z.number(),
  collectionId: z.string().nullable(),
  tier: tierSchema.nullable(),
  reportPath: z.string().nullable(),
  createdAt: z.number(),
  finishedAt: z.number().nullable()
})

export const researchStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  round: z.number(),
  seq: z.number(),
  type: z.enum(['plan', 'search', 'select', 'visit', 'note', 'sufficiency', 'synthesis', 'render']),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  /** Step-specific JSON; renderer casts per type. */
  input: z.unknown(),
  output: z.unknown(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable()
})

export const researchSourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  fetched: z.boolean(),
  cited: z.boolean()
})

export const newsSourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  enabled: z.boolean(),
  lastFetchedAt: z.number().nullable()
})

export const newsItemSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceTitle: z.string().nullable(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  publishedAt: z.number().nullable(),
  summary: z.string().nullable(),
  status: z.enum(['new', 'extracting', 'pending_summary', 'summarized', 'failed']),
  readAt: z.number().nullable(),
  createdAt: z.number()
})

// --- app settings (P2) -------------------------------------------------------

export const appSettingsSchema = z.object({
  profile: z.object({ userName: z.string(), assistantName: z.string() }),
  instructions: z.object({
    global: z.string(),
    perModule: z.partialRecord(featureSchema, z.string())
  }),
  /** Optional-module toggles keyed by module id; core modules are always on. */
  modulesEnabled: z.record(z.string(), z.boolean()),
  /** Unload all models after this many seconds without app activity; 0 disables. */
  idleUnloadSeconds: z.number().int().min(0),
  /** News topic filter applied at fetch time; empty = keep everything. */
  newsTopics: z.array(z.string()),
  /** Per-tier model picks (repo ids) honored by resolveTier. */
  tierSelections: z.partialRecord(tierSchema, z.string())
})

export type AppSettings = z.infer<typeof appSettingsSchema>

// ---------------------------------------------------------------------------
// Method contract: renderer -> main request/response over `orion:call`.
// Every method is zod-validated on both sides of the bridge.
// ---------------------------------------------------------------------------

export const contract = {
  'system.status': {
    input: z.undefined(),
    output: systemStatusSchema
  },
  'system.restartProcess': {
    input: z.object({ name: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'system.openLogs': {
    input: z.undefined(),
    output: z.object({ ok: z.boolean() })
  },
  'system.activity': {
    /** Throttled renderer activity ping — feeds the app-idle model unload. */
    input: z.undefined(),
    output: z.object({ ok: z.boolean() })
  },

  // --- app settings ----------------------------------------------------------
  'settings.get': {
    input: z.undefined(),
    output: appSettingsSchema
  },
  'settings.update': {
    /** Full-object PUT — single user, no merge races. */
    input: z.object({ settings: appSettingsSchema }),
    output: z.object({ ok: z.boolean() })
  },

  // --- models / engine -----------------------------------------------------
  'models.overview': {
    input: z.undefined(),
    output: modelsOverviewSchema
  },
  'models.download': {
    /** force bypasses the QAT validator (PLE bug) — UI must confirm first. */
    input: z.object({ repoId: z.string(), force: z.boolean().optional() }),
    output: z.object({ downloadId: z.string() })
  },
  'models.cancelDownload': {
    input: z.object({ downloadId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'models.delete': {
    input: z.object({ repoId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'models.search': {
    input: z.object({ query: z.string() }),
    output: z.object({ results: z.array(hfSearchResultSchema) })
  },
  'models.load': {
    /** force bypasses the RAM guard's free-memory check — UI must confirm first. */
    input: z.object({ repoId: z.string(), force: z.boolean().optional() }),
    output: z.object({ ok: z.boolean(), reason: z.string().optional() })
  },
  'models.unload': {
    /**
     * Unload one model. The engine has no per-model unload endpoint, so this
     * restarts it (cheap in lazy registry mode) and re-warms the other loaded
     * models in the background.
     */
    input: z.object({ repoId: z.string() }),
    output: z.object({ ok: z.boolean(), reason: z.string().optional() })
  },
  'models.unloadAll': {
    input: z.undefined(),
    output: z.object({ ok: z.boolean() })
  },
  'models.setDefault': {
    input: z.object({ feature: featureSchema, tier: tierSchema }),
    output: z.object({ ok: z.boolean() })
  },
  'models.setTierSelection': {
    /** null clears the pick (back to the first installed curated candidate). */
    input: z.object({ tier: tierSchema, repoId: z.string().nullable() }),
    output: z.object({ ok: z.boolean() })
  },

  // --- chat ------------------------------------------------------------------
  'chat.list': {
    input: z.object({ archived: z.boolean().optional() }).optional(),
    output: z.object({ conversations: z.array(conversationMetaSchema) })
  },
  'chat.create': {
    input: z.object({
      tier: tierSchema.optional(),
      collectionId: z.string().optional(),
      webEnabled: z.boolean().optional()
    }),
    output: z.object({ conversation: conversationSchema })
  },
  'chat.get': {
    input: z.object({ conversationId: z.string() }),
    output: conversationViewSchema
  },
  'chat.send': {
    /** Starts streaming; chat.delta/chat.done events carry the response. */
    input: z.object({
      conversationId: z.string(),
      text: z.string(),
      attachments: z.array(attachmentInputSchema).optional(),
      tier: tierSchema.optional()
    }),
    output: z.object({ messageId: z.string(), assistantMessageId: z.string() })
  },
  'chat.abort': {
    input: z.object({ conversationId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'chat.regenerate': {
    /** messageId = the assistant message to fork a sibling of. */
    input: z.object({ conversationId: z.string(), messageId: z.string() }),
    output: z.object({ assistantMessageId: z.string() })
  },
  'chat.editResend': {
    /** messageId = the user message being edited; creates a sibling + regenerates. */
    input: z.object({ conversationId: z.string(), messageId: z.string(), text: z.string() }),
    output: z.object({ messageId: z.string(), assistantMessageId: z.string() })
  },
  'chat.switchBranch': {
    /** Moves the head to the newest leaf under messageId's branch. */
    input: z.object({ conversationId: z.string(), messageId: z.string() }),
    output: conversationViewSchema
  },
  'chat.update': {
    input: z.object({
      conversationId: z.string(),
      title: z.string().optional(),
      systemPrompt: z.string().nullable().optional(),
      defaultTier: tierSchema.optional(),
      collectionId: z.string().nullable().optional(),
      webEnabled: z.boolean().optional(),
      archived: z.boolean().optional()
    }),
    output: z.object({ ok: z.boolean() })
  },
  'chat.delete': {
    input: z.object({ conversationId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },

  // --- library ----------------------------------------------------------------
  'library.collections': {
    input: z.undefined(),
    output: z.object({ collections: z.array(collectionSchema) })
  },
  'library.createCollection': {
    input: z.object({ name: z.string() }),
    output: z.object({ collection: collectionSchema })
  },
  'library.deleteCollection': {
    input: z.object({ collectionId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'library.docs': {
    input: z.object({ collectionId: z.string() }),
    output: z.object({ docs: z.array(libraryDocSchema) })
  },
  'library.ingest': {
    /** Async — progress arrives via library.docStatus events. */
    input: z.object({
      collectionId: z.string(),
      path: z.string().optional(),
      url: z.string().optional()
    }),
    output: z.object({ docId: z.string() })
  },
  'library.deleteDoc': {
    input: z.object({ docId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },

  // --- MCP ----------------------------------------------------------------------
  'mcp.list': {
    input: z.undefined(),
    output: z.object({ servers: z.array(mcpServerSchema) })
  },
  'mcp.upsert': {
    input: z.object({ server: mcpServerSchema }),
    output: z.object({ server: mcpServerSchema })
  },
  'mcp.remove': {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'mcp.test': {
    /** Connects, lists tools, disconnects. */
    input: z.object({ id: z.string() }),
    output: z.object({
      ok: z.boolean(),
      tools: z.array(z.string()).optional(),
      error: z.string().optional()
    })
  },

  // --- skills ---------------------------------------------------------------------
  'skills.list': {
    input: z.undefined(),
    output: z.object({ skills: z.array(skillMetaSchema) })
  },
  'skills.setAgentEnabled': {
    /** Symlinks the skill into ~/.config/opencode/skills for Agent/Code tabs. */
    input: z.object({ name: z.string(), enabled: z.boolean() }),
    output: z.object({ ok: z.boolean() })
  },

  // --- agent (opencode) -------------------------------------------------------------
  'agent.sessions': {
    /** No filters = the Agent tab's list; the Code panel filters by tab+directory. */
    input: z.object({ tab: agentTabSchema.optional(), directory: z.string().optional() }).optional(),
    output: z.object({ sessions: z.array(agentSessionMetaSchema) })
  },
  'agent.create': {
    input: z.object({
      directory: z.string(),
      tier: tierSchema.optional(),
      tab: agentTabSchema.optional()
    }),
    output: z.object({ session: agentSessionMetaSchema })
  },
  'agent.get': {
    /** Session meta + opencode's message list verbatim ([{info, parts}]). */
    input: z.object({ sessionId: z.string() }),
    output: z.object({ session: agentSessionMetaSchema, messages: z.array(z.unknown()) })
  },
  'agent.prompt': {
    /** Fire-and-forget; progress streams via agent.event. */
    input: z.object({ sessionId: z.string(), text: z.string(), tier: tierSchema.optional() }),
    output: z.object({ ok: z.boolean() })
  },
  'agent.abort': {
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'agent.permissionReply': {
    input: z.object({
      sessionId: z.string(),
      permissionId: z.string(),
      reply: z.enum(['once', 'always', 'reject'])
    }),
    output: z.object({ ok: z.boolean() })
  },
  'agent.delete': {
    input: z.object({ sessionId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'agent.pickDirectory': {
    /** Native folder picker; null when cancelled. */
    input: z.undefined(),
    output: z.object({ path: z.string().nullable() })
  },

  // --- agent memory ------------------------------------------------------------------
  'memory.list': {
    input: z.undefined(),
    output: z.object({
      files: z.array(z.object({ name: z.string(), updatedAt: z.number() }))
    })
  },
  'memory.read': {
    input: z.object({ name: z.string() }),
    output: z.object({ content: z.string() })
  },
  'memory.write': {
    /** Empty content deletes the file. */
    input: z.object({ name: z.string(), content: z.string() }),
    output: z.object({ ok: z.boolean() })
  },

  // --- code workspace (fs is jailed under the chosen root) ---------------------------
  'code.pickWorkspace': {
    /** Native folder picker; remembers the last workspace. Null when cancelled. */
    input: z.undefined(),
    output: z.object({ path: z.string().nullable() })
  },
  'code.lastWorkspace': {
    input: z.undefined(),
    output: z.object({ path: z.string().nullable() })
  },
  'code.openWorkspace': {
    /** Validates the root, starts the chokidar watcher, returns the top level. */
    input: z.object({ root: z.string() }),
    output: z.object({ entries: z.array(workspaceEntrySchema) })
  },
  'code.closeWorkspace': {
    input: z.object({ root: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'code.listDir': {
    /** Lazy per-directory listing; dir is workspace-relative ('' = root). */
    input: z.object({ root: z.string(), dir: z.string() }),
    output: z.object({ entries: z.array(workspaceEntrySchema) })
  },
  'code.readFile': {
    input: z.object({ root: z.string(), path: z.string() }),
    output: z.object({ content: z.string(), mtime: z.number() })
  },
  'code.writeFile': {
    /**
     * expectedMtime guards against clobbering disk changes: when set and the
     * file is newer, the write is refused with conflict=true.
     */
    input: z.object({
      root: z.string(),
      path: z.string(),
      content: z.string(),
      expectedMtime: z.number().optional()
    }),
    output: z.object({ ok: z.boolean(), mtime: z.number().nullable(), conflict: z.boolean() })
  },
  'code.createFile': {
    /** Empty file; fails when the path already exists. */
    input: z.object({ root: z.string(), path: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'code.createDir': {
    input: z.object({ root: z.string(), path: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'code.move': {
    /** Rename and cut+paste; fails when the destination exists. */
    input: z.object({ root: z.string(), from: z.string(), to: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'code.copy': {
    /** Recursive for directories; fails when the destination exists. */
    input: z.object({ root: z.string(), from: z.string(), to: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'code.delete': {
    /** Moves to the macOS Trash (recoverable), never a hard unlink. */
    input: z.object({ root: z.string(), path: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'code.reveal': {
    /** Reveal in Finder. */
    input: z.object({ root: z.string(), path: z.string() }),
    output: z.object({ ok: z.boolean() })
  },

  // --- research --------------------------------------------------------------------
  'research.start': {
    input: z.object({
      question: z.string(),
      mode: researchModeSchema.optional(),
      tier: tierSchema.optional(),
      collectionId: z.string().optional()
    }),
    output: z.object({ runId: z.string() })
  },
  'research.list': {
    input: z.undefined(),
    output: z.object({ runs: z.array(researchRunMetaSchema) })
  },
  'research.get': {
    input: z.object({ runId: z.string() }),
    output: z.object({
      run: researchRunMetaSchema,
      steps: z.array(researchStepSchema),
      sources: z.array(researchSourceSchema)
    })
  },
  'research.cancel': {
    input: z.object({ runId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'research.resume': {
    /** Re-enters the loop from the last persisted step (crash recovery). */
    input: z.object({ runId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'research.delete': {
    input: z.object({ runId: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'research.report': {
    /** html for the sandboxed iframe; report = the model's structured JSON. */
    input: z.object({ runId: z.string() }),
    output: z.object({ html: z.string().nullable(), report: z.unknown() })
  },
  'research.exportPdf': {
    input: z.object({ runId: z.string() }),
    output: z.object({ path: z.string().nullable() })
  },

  // --- news ------------------------------------------------------------------------
  'news.sources': {
    input: z.undefined(),
    output: z.object({ sources: z.array(newsSourceSchema) })
  },
  'news.addSource': {
    input: z.object({ url: z.string() }),
    output: z.object({ source: newsSourceSchema })
  },
  'news.updateSource': {
    input: z.object({ id: z.string(), enabled: z.boolean() }),
    output: z.object({ ok: z.boolean() })
  },
  'news.removeSource': {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'news.items': {
    /** Unread first, newest first; paused = summaries waiting on the ultra model. */
    input: z.object({ limit: z.number().optional() }).optional(),
    output: z.object({ items: z.array(newsItemSchema), paused: z.boolean() })
  },
  'news.read': {
    /** Full extracted article body for the reader view; marks the item read. */
    input: z.object({ itemId: z.string() }),
    output: z.object({ markdown: z.string().nullable() })
  },
  'news.markAllRead': {
    input: z.undefined(),
    output: z.object({ ok: z.boolean() })
  },
  'news.refresh': {
    /** Manual fetch cycle across all enabled sources; returns immediately. */
    input: z.undefined(),
    output: z.object({ ok: z.boolean() })
  },

  // --- terminal (node-pty) -------------------------------------------------------------
  'term.create': {
    /** Login shell with cwd inside the workspace; output streams via term.data. */
    input: z.object({ cwd: z.string(), cols: z.number(), rows: z.number() }),
    output: z.object({ termId: z.string() })
  },
  'term.write': {
    input: z.object({ termId: z.string(), data: z.string() }),
    output: z.object({ ok: z.boolean() })
  },
  'term.resize': {
    input: z.object({ termId: z.string(), cols: z.number(), rows: z.number() }),
    output: z.object({ ok: z.boolean() })
  },
  'term.kill': {
    input: z.object({ termId: z.string() }),
    output: z.object({ ok: z.boolean() })
  }
} as const

export type Contract = typeof contract
export type MethodName = keyof Contract
export type MethodInput<M extends MethodName> = z.infer<Contract[M]['input']>
export type MethodOutput<M extends MethodName> = z.infer<Contract[M]['output']>

/** Envelope returned by main for every `orion:call` invoke. */
export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string }

// ---------------------------------------------------------------------------
// Event bus: main -> renderer over the single `orion:event` channel.
// ---------------------------------------------------------------------------

export const orionEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('system.processState'),
    process: processSnapshotSchema
  }),
  z.object({
    type: z.literal('system.toast'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string()
  }),
  z.object({
    type: z.literal('system.ramReport'),
    ram: ramReportSchema
  }),
  z.object({
    /** App settings were updated (Settings page or main-side mutators). */
    type: z.literal('settings.changed'),
    settings: appSettingsSchema
  }),
  z.object({
    type: z.literal('models.downloadProgress'),
    download: downloadInfoSchema
  }),
  z.object({
    type: z.literal('models.statusChanged'),
    engine: engineStatusSchema
  }),
  z.object({
    /**
     * The set of installed models changed (first cache scan finished, a
     * download completed, a delete ran). Carries no payload — listeners
     * refetch the overview, which is already assembled main-side.
     */
    type: z.literal('models.installedChanged')
  }),
  z.object({
    type: z.literal('chat.delta'),
    conversationId: z.string(),
    messageId: z.string(),
    /** Index of the part this delta targets within the assistant message. */
    partIndex: z.number(),
    part: messagePartSchema,
    /** true = append part.text to the existing part; false = insert/replace whole part. */
    append: z.boolean()
  }),
  z.object({
    type: z.literal('chat.toolEvent'),
    conversationId: z.string(),
    messageId: z.string(),
    toolCallId: z.string(),
    name: z.string(),
    phase: z.enum(['start', 'result', 'error']),
    detail: z.string().optional()
  }),
  z.object({
    type: z.literal('chat.done'),
    conversationId: z.string(),
    messageId: z.string(),
    aborted: z.boolean(),
    error: z.string().nullable(),
    tokensIn: z.number().nullable(),
    tokensOut: z.number().nullable(),
    /** Context window of the model that generated this message; donut denominator. */
    contextLength: z.number().nullable()
  }),
  z.object({
    type: z.literal('chat.titleChanged'),
    conversationId: z.string(),
    title: z.string()
  }),
  z.object({
    /** Raw opencode SSE event for one of our sessions — renderer casts. */
    type: z.literal('agent.event'),
    sessionId: z.string(),
    /** Owning surface — the Agent tab and Code panel each reduce only theirs. */
    tab: agentTabSchema,
    event: z.unknown()
  }),
  z.object({
    /** Permission ask surfaced from opencode; reply via agent.permissionReply. */
    type: z.literal('agent.permissionRequest'),
    sessionId: z.string(),
    tab: agentTabSchema,
    request: z.unknown()
  }),
  z.object({
    /** Batch of workspace paths that changed on disk (chokidar, debounced). */
    type: z.literal('code.fsChanged'),
    root: z.string(),
    paths: z.array(z.string())
  }),
  z.object({
    /** A research step was created or changed state. */
    type: z.literal('research.step'),
    runId: z.string(),
    step: researchStepSchema
  }),
  z.object({
    /** Items/sources changed (fetch cycle, summaries, reads) — refetch. */
    type: z.literal('news.updated')
  }),
  z.object({
    type: z.literal('research.status'),
    runId: z.string(),
    status: researchStatusSchema,
    round: z.number()
  }),
  z.object({
    /** PTY output chunk (batched ~16ms in main). */
    type: z.literal('term.data'),
    termId: z.string(),
    data: z.string()
  }),
  z.object({
    type: z.literal('term.exit'),
    termId: z.string(),
    exitCode: z.number().nullable()
  }),
  z.object({
    type: z.literal('library.docStatus'),
    doc: libraryDocSchema
  })
])

export type OrionEvent = z.infer<typeof orionEventSchema>
export type OrionEventType = OrionEvent['type']
export type OrionEventOf<T extends OrionEventType> = Extract<OrionEvent, { type: T }>
