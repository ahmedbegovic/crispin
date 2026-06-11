import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { CrispinEvent } from '@shared/ipc'
import type {
  AttachmentInput,
  Conversation,
  MessagePart,
  ModelSampling,
  Tier
} from '@shared/types'
import { TIERS, tierOfRepo } from '@shared/model-tiers'
import type { CrispinDatabase } from '../db'
import * as settings from '../settings'
import { dataDir } from '../paths'
import { scopedLogger } from '../logger'
import {
  engineModelId,
  type ChatCompletionMessage,
  type ChatContentPart,
  type ChatToolDef,
  type EngineClient,
  type WireToolCall
} from '../engine-client'
import type { ToolsClient } from '../tools-client'
import type { ModelService } from '../model-service'
import type { McpManager } from '../mcp-manager'
import type { SkillsService } from '../skills'
import type { AppSettingsService } from '../app-settings'
import { EMBEDDING_MODEL, type LibraryService } from '../library-service'
import type { ChatRepo } from './repo'
import { buildSystemPrompt, cleanTitle, instantTitle, titleMessages } from './prompts'
import {
  createContentSplitter,
  encodesToolHistoryAsText,
  familyOf,
  salvageTextualToolCalls,
  stripThoughts,
  type ModelFamily
} from './family'
import {
  builtinToolDefs,
  executeTool,
  InvalidToolArgsError,
  SourceTracker,
  type ToolExecutionContext
} from './tools'
import { traceLlm } from '../llm-trace'
import { heuristicRoute, routeWithModel, type ChatRoute } from './search-router'
import {
  runSearchPipeline,
  runVisitPipeline,
  type PipelineEvidence,
  type SearchPipelineOptions
} from './search-pipeline'

const MAX_TOOL_ITERATIONS = 8
const DELTA_COALESCE_MS = 30
const PERSIST_INTERVAL_MS = 500
/** Documents extracted at send time: inline below this, library ingest above. */
const INLINE_DOC_LIMIT = 8000
const TOOL_RESULT_LIMIT = 16_000

const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text

// tierOfRepo is rename-aware: a model installed under a renamed old id keeps
// its tier's vision capability and output cap instead of degrading to defaults.
const visionCapable = (modelId: string): boolean => {
  const tier = tierOfRepo(modelId)
  return tier !== null && TIERS[tier].caps.includes('vision')
}

/** Per-request output cap from the model's tier; undefined = engine default. */
const maxTokensFor = (modelId: string): number | undefined => {
  const tier = tierOfRepo(modelId)
  return tier ? TIERS[tier].maxOutputTokens : undefined
}

/**
 * Append text to the trailing user message — gemma's template rejects
 * non-alternating roles, so corrections and evidence blocks extend the user
 * turn instead of pushing a second one. Falls back to a new user message
 * when the history doesn't end with one.
 */
function appendToTrailingUserMessage(messages: ChatCompletionMessage[], text: string): void {
  const last = messages[messages.length - 1]
  if (last && last.role === 'user' && typeof last.content === 'string') {
    last.content = `${last.content}\n\n${text}`
  } else if (last && last.role === 'user' && Array.isArray(last.content)) {
    // Vision message: extend its text part rather than appending a second
    // user turn the alternating template would reject.
    const textPart = last.content.findLast((p) => p.type === 'text')
    if (textPart && textPart.type === 'text') textPart.text = `${textPart.text}\n\n${text}`
    else last.content.push({ type: 'text', text })
  } else {
    messages.push({ role: 'user', content: text })
  }
}

/** Last few turns as plain text (thoughts and tool parts dropped) — feeds the
 * router's reference resolution ("what about Montreal?"). */
function recentTextHistory(
  path: Array<{ role: string; parts: MessagePart[] }>,
  lastUser: { role: string; parts: MessagePart[] }
): Array<{ role: 'user' | 'assistant'; text: string }> {
  const idx = path.indexOf(lastUser as (typeof path)[number])
  const prior = (idx >= 0 ? path.slice(0, idx) : path).filter(
    (m) => m.role === 'user' || m.role === 'assistant'
  )
  return prior
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      text: m.parts
        .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
        .trim()
    }))
    .filter((h) => h.text)
    .slice(-4)
}

/**
 * Streams one assistant message: owns its parts array, coalesces chat.delta
 * broadcasts (~30ms) and persists incrementally (~500ms) so a crash mid-stream
 * loses at most half a second of text.
 */
class PartStream {
  private readonly parts: MessagePart[] = []
  private pending = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastPersistAt = 0

  constructor(
    private readonly conversationId: string,
    private readonly messageId: string,
    private readonly repo: ChatRepo,
    private readonly broadcast: (event: CrispinEvent) => void
  ) {}

  append(channel: 'text' | 'thought', text: string): void {
    if (!text) return
    const last = this.parts[this.parts.length - 1]
    if (last && (last.type === 'text' || last.type === 'thought') && last.type === channel) {
      last.text += text
      this.pending += text
      if (!this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.flushPending()
        }, DELTA_COALESCE_MS)
      }
    } else {
      this.add({ type: channel, text })
    }
  }

  add(part: MessagePart): void {
    this.flushPending()
    this.parts.push(part)
    this.broadcast({
      type: 'chat.delta',
      conversationId: this.conversationId,
      messageId: this.messageId,
      partIndex: this.parts.length - 1,
      part,
      append: false
    })
    this.persist(true)
  }

  finalize(tokens: { tokensIn: number | null; tokensOut: number | null }): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.flushPending()
    this.repo.updateParts(this.messageId, this.parts, tokens)
  }

  snapshot(): MessagePart[] {
    return this.parts
  }

  private flushPending(): void {
    if (!this.pending) return
    const index = this.parts.length - 1
    const part = this.parts[index]
    this.broadcast({
      type: 'chat.delta',
      conversationId: this.conversationId,
      messageId: this.messageId,
      partIndex: index,
      part: { type: part.type as 'text' | 'thought', text: this.pending },
      append: true
    })
    this.pending = ''
    this.persist(false)
  }

  private persist(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastPersistAt < PERSIST_INTERVAL_MS) return
    this.lastPersistAt = now
    this.repo.updateParts(this.messageId, this.parts)
  }
}

export interface ChatOrchestratorDeps {
  db: CrispinDatabase
  repo: ChatRepo
  engine: EngineClient
  tools: ToolsClient
  modelService: ModelService
  mcp: McpManager
  skills: SkillsService
  library: LibraryService
  appSettings: AppSettingsService
  broadcast: (event: CrispinEvent) => void
}

interface RunContext {
  conversationId: string
  assistantMessageId: string
  modelId: string
  family: ModelFamily
  controller: AbortController
}

/** Drives generations: one active per conversation, tool loop, persistence. */
export class ChatOrchestrator {
  private readonly active = new Map<string, AbortController>()
  private readonly attachmentsDir = join(dataDir(), 'attachments')
  private readonly log = scopedLogger('chat')

  constructor(private readonly deps: ChatOrchestratorDeps) {
    mkdirSync(this.attachmentsDir, { recursive: true })
  }

  dispose(): void {
    for (const controller of this.active.values()) controller.abort()
    this.active.clear()
  }

  // --- entry points -------------------------------------------------------------

  async send(input: {
    conversationId: string
    text: string
    attachments?: AttachmentInput[]
    tier?: Tier
  }): Promise<{ messageId: string; assistantMessageId: string }> {
    const conversation = this.deps.repo.getConversation(input.conversationId)
    const controller = this.claim(input.conversationId)
    try {
      const modelId = this.resolveModel(input.tier ?? this.effectiveTier(conversation))
      const prepared = await this.prepareUserParts(input.text, input.attachments ?? [], conversation.collectionId)
      const messageId = this.deps.repo.insertMessage({
        conversationId: conversation.id,
        parentId: conversation.headMessageId,
        role: 'user',
        parts: prepared.parts
      })
      for (const att of prepared.attachments) {
        this.deps.repo.insertAttachment({ ...att, messageId })
      }
      // Instant title: the truncated first question, broadcast before any
      // tokens stream. The low-tier refinement may improve on it later.
      if (conversation.title === 'New chat' && conversation.headMessageId === null) {
        const title = instantTitle(input.text)
        if (title) {
          this.deps.repo.setTitle(conversation.id, title)
          this.deps.broadcast({ type: 'chat.titleChanged', conversationId: conversation.id, title })
        }
      }
      const assistantMessageId = this.deps.repo.insertMessage({
        conversationId: conversation.id,
        parentId: messageId,
        role: 'assistant',
        parts: [],
        modelId
      })
      this.deps.repo.setHead(conversation.id, assistantMessageId)
      this.start({ conversationId: conversation.id, assistantMessageId, modelId, family: familyOf(modelId), controller })
      return { messageId, assistantMessageId }
    } catch (err) {
      this.active.delete(input.conversationId)
      throw err
    }
  }

  async regenerate(conversationId: string, messageId: string): Promise<{ assistantMessageId: string }> {
    const conversation = this.deps.repo.getConversation(conversationId)
    const message = this.deps.repo.getMessage(messageId)
    if (message.role !== 'assistant') throw new Error('Can only regenerate assistant messages')
    const controller = this.claim(conversationId)
    try {
      const modelId = this.resolveModel(this.effectiveTier(conversation))
      const assistantMessageId = this.deps.repo.insertMessage({
        conversationId,
        parentId: message.parentId, // sibling of the regenerated message
        role: 'assistant',
        parts: [],
        modelId
      })
      this.deps.repo.setHead(conversationId, assistantMessageId)
      this.start({ conversationId, assistantMessageId, modelId, family: familyOf(modelId), controller })
      return { assistantMessageId }
    } catch (err) {
      this.active.delete(conversationId)
      throw err
    }
  }

  async editResend(
    conversationId: string,
    messageId: string,
    text: string
  ): Promise<{ messageId: string; assistantMessageId: string }> {
    const conversation = this.deps.repo.getConversation(conversationId)
    const edited = this.deps.repo.getMessage(messageId)
    if (edited.role !== 'user') throw new Error('Can only edit user messages')
    const controller = this.claim(conversationId)
    try {
      const modelId = this.resolveModel(this.effectiveTier(conversation))
      const newMessageId = this.deps.repo.insertMessage({
        conversationId,
        parentId: edited.parentId, // sibling of the edited message
        role: 'user',
        parts: [{ type: 'text', text }]
      })
      const assistantMessageId = this.deps.repo.insertMessage({
        conversationId,
        parentId: newMessageId,
        role: 'assistant',
        parts: [],
        modelId
      })
      this.deps.repo.setHead(conversationId, assistantMessageId)
      this.start({ conversationId, assistantMessageId, modelId, family: familyOf(modelId), controller })
      return { messageId: newMessageId, assistantMessageId }
    } catch (err) {
      this.active.delete(conversationId)
      throw err
    }
  }

  abort(conversationId: string): boolean {
    const controller = this.active.get(conversationId)
    if (!controller) return false
    controller.abort()
    return true
  }

  isActive(conversationId: string): boolean {
    return this.active.has(conversationId)
  }

  // --- generation --------------------------------------------------------------

  /** Pinned conversations keep their snapshot; un-pinned follow featureDefaults.chat live. */
  private effectiveTier(conversation: Conversation): Tier {
    if (conversation.tierPinned) return conversation.defaultTier
    return this.deps.modelService.overview().defaults.chat
  }

  /** Reserve the conversation's single generation slot before any awaits. */
  private claim(conversationId: string): AbortController {
    if (this.active.has(conversationId)) {
      throw new Error('A generation is already running in this conversation')
    }
    const controller = new AbortController()
    this.active.set(conversationId, controller)
    return controller
  }

  private start(ctx: RunContext): void {
    void this.run(ctx).catch((err) => {
      // run() handles its own errors; this guards the handler itself.
      this.log.error(`run crashed: ${err instanceof Error ? (err.stack ?? err.message) : err}`)
      this.active.delete(ctx.conversationId)
    })
  }

  private async run(ctx: RunContext): Promise<void> {
    const { conversationId, assistantMessageId, modelId, family, controller } = ctx
    const stream = new PartStream(conversationId, assistantMessageId, this.deps.repo, this.deps.broadcast)
    const sources = new SourceTracker()
    let aborted = false
    let error: string | null = null
    let tokensIn: number | null = null
    let tokensOut: number | null = null

    try {
      // A cold load can take minutes and is not itself cancellable (the warm
      // request counts toward inflight and may as well finish in the
      // background) — but Stop must release THIS run immediately.
      const loading = this.ensureModelLoaded(modelId)
      loading.catch(() => {}) // abandoned on abort — never an unhandled rejection
      await Promise.race([
        loading,
        new Promise<never>((_, reject) => {
          const onAbort = (): void => reject(new Error('aborted'))
          if (controller.signal.aborted) onAbort()
          else controller.signal.addEventListener('abort', onAbort, { once: true })
        })
      ])
      if (controller.signal.aborted) throw new Error('aborted')

      const conversation = this.deps.repo.getConversation(conversationId)
      // Chat sees only explicitly opted-in skills — coding packs symlinked for
      // the Agent/Code tabs must not leak into chat prompts (v2 feedback).
      const skills = this.deps.skills.list().filter((s) => s.chatEnabled)
      const webEnabled = conversation.webEnabled
      const hasCollection = conversation.collectionId !== null
      const path = this.deps.repo
        .activePath(conversationId)
        .filter((m) => m.id !== assistantMessageId)
      const appSettings = this.deps.appSettings.get()
      const messages = this.buildHistory(path, family, visionCapable(modelId), {
        customPrompt: conversation.systemPrompt,
        skills,
        webEnabled,
        ragEnabled: hasCollection,
        userName: appSettings.profile.userName,
        assistantName: appSettings.profile.assistantName,
        instructions: [
          appSettings.instructions.global,
          appSettings.instructions.perModule.chat ?? ''
        ]
      })

      const toolDefs = [
        ...builtinToolDefs({ webEnabled, hasCollection, skills }),
        ...(await this.deps.mcp.toolDefsFor('chat'))
      ]
      if (controller.signal.aborted) throw new Error('aborted')
      const toolCtx: ToolExecutionContext = {
        tools: this.deps.tools,
        skills: this.deps.skills,
        mcp: this.deps.mcp,
        sources,
        collectionId: conversation.collectionId,
        embeddingsUrl: this.deps.library.embeddingsUrl(),
        embeddingModel: engineModelId(EMBEDDING_MODEL),
        lancedbDir: this.deps.library.lancedbDir(),
        searxngUrl: settings.get(this.deps.db, 'search.searxngUrl', 'http://127.0.0.1:8080'),
        signal: controller.signal
      }

      // The model's own generation_config.json sampling (gemma: 1.0/0.95) —
      // without it the engine falls back to its generic 0.7/0.9 defaults.
      const sampling = this.deps.modelService.samplingFor(modelId)

      // Harness-owned web pipeline: when routing says the turn needs the web,
      // gather the evidence up front and let the model only write the answer —
      // small models under-search when they own the loop. A 'direct' verdict
      // or ANY non-abort failure leaves toolDefs untouched: exactly today's
      // loop. Collection chats stay model-owned too: a tools-off synthesis
      // round would take rag_search away from the very turn that needs it.
      let loopToolDefs = toolDefs
      if (webEnabled && !hasCollection) {
        const evidence = await this.tryGatherWebEvidence({ ctx, stream, path, sources, toolCtx })
        if (evidence) {
          appendToTrailingUserMessage(messages, evidence.text)
          // Evidence in hand: tools off, so the model synthesizes instead of
          // re-looping (and cites the [n] numbers the pipeline minted).
          loopToolDefs = []
        }
      }

      const finished = await this.runModelLoop({
        ctx,
        stream,
        messages,
        toolDefs: loopToolDefs,
        toolCtx,
        sampling
      })
      tokensIn = finished.tokensIn
      tokensOut = finished.tokensOut

      if (sources.all().length > 0) {
        stream.add({ type: 'sources', sources: sources.all() })
      }
    } catch (err) {
      if (controller.signal.aborted) {
        aborted = true
      } else {
        error = err instanceof Error ? err.message : String(err)
        this.log.warn(`generation failed: ${error}`)
        // An engine-side failure (e.g. the prefill memory guard) may have
        // evicted models — reconcile now so the Models tab doesn't show a
        // stale "Loaded" badge until the next 2.5s poll.
        void this.deps.modelService.refreshEngineModels().catch(() => {})
      }
    } finally {
      stream.finalize({ tokensIn, tokensOut })
      this.active.delete(conversationId)
      this.deps.broadcast({
        type: 'chat.done',
        conversationId,
        messageId: assistantMessageId,
        aborted,
        error,
        tokensIn,
        tokensOut,
        contextLength: this.deps.modelService.contextLengthFor(modelId)
      })
    }

    if (!aborted && !error) {
      void this.maybeGenerateTitle(conversationId).catch((err) => {
        this.log.warn(`title generation failed: ${err instanceof Error ? err.message : err}`)
      })
    }
  }

  /**
   * Route the turn and, when it needs the web, run the harness-owned search
   * pipeline. Returns the evidence block to append to the trailing user
   * message, or null for "run today's model loop" — a direct verdict, an
   * image/attachment turn, or any non-abort failure all degrade there.
   */
  private async tryGatherWebEvidence(args: {
    ctx: RunContext
    stream: PartStream
    path: Array<{ role: string; parts: MessagePart[] }>
    sources: SourceTracker
    toolCtx: ToolExecutionContext
  }): Promise<PipelineEvidence | null> {
    const { ctx, stream, path, sources, toolCtx } = args
    const { controller } = ctx
    try {
      const lastUser = path.findLast((m) => m.role === 'user')
      if (!lastUser) return null
      // Image and document turns stay model-owned: the router can't see an
      // image, and a turn that attaches a document is about the document
      // (prepareUserParts appends extra text parts for attachments).
      if (lastUser.parts.some((p) => p.type === 'image')) return null
      const textParts = lastUser.parts.filter(
        (p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text'
      )
      if (textParts.length !== 1) return null
      const question = textParts[0].text.trim()
      if (!question) return null

      const priorAssistant = path.findLast((m) => m.role === 'assistant')
      const priorUsedWeb =
        priorAssistant?.parts.some(
          (p) => p.type === 'tool_call' && (p.name === 'web_search' || p.name === 'web_visit')
        ) ?? false

      const decision = heuristicRoute(question, priorUsedWeb)
      if (decision.kind === 'direct') return null
      let route: ChatRoute
      if (decision.kind === 'visit') {
        route = { kind: 'visit', urls: decision.urls }
      } else {
        route = await routeWithModel({
          engine: this.deps.engine,
          model: ctx.modelId,
          question,
          history: recentTextHistory(path, lastUser),
          forceSearch: decision.forceSearch,
          conversationId: ctx.conversationId,
          signal: controller.signal
        })
      }
      if (route.kind === 'direct') return null

      const opts: SearchPipelineOptions = {
        engine: this.deps.engine,
        tools: this.deps.tools,
        model: ctx.modelId,
        question,
        conversationId: ctx.conversationId,
        sources,
        searxngUrl: toolCtx.searxngUrl,
        signal: controller.signal,
        emit: {
          addPart: (part) => stream.add(part),
          toolEvent: (id, name, phase, detail) => this.toolEvent(ctx, id, name, phase, detail)
        }
      }
      return route.kind === 'visit'
        ? await runVisitPipeline(route.urls, opts)
        : await runSearchPipeline(route.queries, opts)
    } catch (err) {
      // Abort propagates to run()'s handler; everything else degrades.
      if (controller.signal.aborted) throw err
      this.log.warn(
        `search pipeline failed, falling back to the model loop: ${err instanceof Error ? err.message : err}`
      )
      return null
    }
  }

  /**
   * The model-owned ReAct loop: stream a round, execute its tool calls,
   * repeat until the model answers in text or the budget forces a final
   * tools-disabled round. Also serves as the synthesis round after the
   * search pipeline gathered evidence (toolDefs: [] — the model can't
   * re-loop, it can only write the answer).
   */
  private async runModelLoop(args: {
    ctx: RunContext
    stream: PartStream
    messages: ChatCompletionMessage[]
    toolDefs: ChatToolDef[]
    toolCtx: ToolExecutionContext
    sampling: ModelSampling | null
  }): Promise<{ tokensIn: number | null; tokensOut: number | null }> {
    const { ctx, stream, messages, toolDefs, toolCtx, sampling } = args
    const { modelId, family, controller } = ctx
    // Derived from THIS loop's defs: in the post-pipeline synthesis round
    // (toolDefs: []) the salvage net must not convert gemma's imitated
    // '[tool_call]' lines into real executions — empty set, no matches.
    const knownToolNames = new Set(toolDefs.map((d) => d.function.name))
    let tokensIn: number | null = null
    let tokensOut: number | null = null

    let parseErrorLastIteration = false
    let toolBudgetExhausted = false
    let nudgedEmptyTurn = false
    // <= cap: one extra tools-disabled round so a cap exit still produces an answer.
    for (let iteration = 0; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
      const splitter = createContentSplitter(family)
      const roundStartedAt = Date.now()
      let finishReason: string | null = null
      let visibleText = ''
      let toolCalls: WireToolCall[] = []
      const consume = (segments: ReturnType<typeof splitter.push>): void => {
        for (const seg of segments) {
          stream.append(seg.channel, seg.text)
          if (seg.channel === 'text') visibleText += seg.text
        }
      }

      for await (const event of this.deps.engine.streamChat({
        model: modelId,
        messages,
        tools: !toolBudgetExhausted && toolDefs.length > 0 ? toolDefs : undefined,
        maxTokens: maxTokensFor(modelId),
        temperature: sampling?.temperature ?? undefined,
        topP: sampling?.topP ?? undefined,
        topK: sampling?.topK ?? undefined,
        signal: controller.signal
      })) {
        if (event.type === 'content') consume(splitter.push(event.text))
        else if (event.type === 'reasoning') stream.append('thought', event.text)
        else {
          toolCalls = event.toolCalls
          finishReason = event.finishReason
          // Last round only, NOT summed: the final prompt already re-encodes
          // every earlier round's output, so tokensIn + tokensOut is the true
          // end-of-generation context size (the donut's numerator).
          tokensIn = event.tokensIn ?? tokensIn
          tokensOut = event.tokensOut ?? tokensOut
        }
      }
      consume(splitter.flush())
      traceLlm({
        surface: 'chat',
        step: toolDefs.length > 0 ? 'loop' : 'synthesis',
        conversationId: ctx.conversationId,
        model: modelId,
        messages,
        output: visibleText,
        parsed: toolCalls.length > 0 ? toolCalls : undefined,
        ok: true,
        finishReason,
        tokensIn,
        tokensOut,
        ms: Date.now() - roundStartedAt
      })

      // Imitated textual tool calls: the text-encoded history teaches gemma
      // the literal '[tool_call] name(args)' shape and it sometimes emits
      // that as content instead of a native call — execute those instead of
      // ending the turn with dead prose. cleanedText keeps the history from
      // recording the call twice (the round's callText re-encodes it).
      if (toolCalls.length === 0 && !toolBudgetExhausted && encodesToolHistoryAsText(family)) {
        const salvage = salvageTextualToolCalls(visibleText, knownToolNames)
        if (salvage.calls.length > 0) {
          toolCalls = salvage.calls
          visibleText = salvage.cleanedText
        }
      }

      // Reasoning-only turn: gemma sometimes plans a tool call in its
      // thinking ("The best tool for this is web_search…") and then stops
      // without emitting the call or any visible text. One corrective round;
      // a second empty turn ends the generation as before. The nudge is
      // appended to the trailing user message when there is one — gemma's
      // template rejects non-alternating roles.
      // iteration guard: never trade the budget-exhausted round for a nudge —
      // the loop's "tools disabled on the final round" invariant must hold.
      if (
        toolCalls.length === 0 &&
        !visibleText.trim() &&
        !toolBudgetExhausted &&
        !nudgedEmptyTurn &&
        iteration < MAX_TOOL_ITERATIONS - 1
      ) {
        nudgedEmptyTurn = true
        // The nudged round runs no tools, so it cannot "fail again" — a
        // stale parse-error flag from the round before it must not pair
        // with a later error as 'consecutive' (adversarial-review finding).
        parseErrorLastIteration = false
        const nudge =
          '(Your previous turn produced no reply — only internal thinking. ' +
          'Continue now: call the tool you decided on, or answer the user directly. ' +
          'Do not mention this reminder.)'
        appendToTrailingUserMessage(messages, nudge)
        continue
      }

      if (toolCalls.length === 0 || toolBudgetExhausted) break

      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        // Budget spent: drop this round's calls and force one final text answer.
        if (visibleText.trim()) {
          messages.push({ role: 'assistant', content: visibleText.trim() })
        }
        messages.push({
          role: 'user',
          content:
            'Tool budget exhausted — do not call any more tools. ' +
            'Answer the original question now from the tool results you already have.'
        })
        toolBudgetExhausted = true
        continue
      }

      // Record the assistant turn the way this family can actually read back.
      if (encodesToolHistoryAsText(family)) {
        const callText = toolCalls
          .map((c) => `[tool_call] ${c.function.name}(${c.function.arguments})`)
          .join('\n')
        messages.push({
          role: 'assistant',
          content: [visibleText.trim(), callText].filter(Boolean).join('\n\n')
        })
      } else {
        messages.push({ role: 'assistant', content: visibleText || null, tool_calls: toolCalls })
      }

      const resultTexts: string[] = []
      let parseErrorThisIteration = false
      for (const call of toolCalls) {
        if (controller.signal.aborted) throw new Error('aborted')
        const name = call.function.name
        stream.add({ type: 'tool_call', id: call.id, name, args: call.function.arguments })
        this.toolEvent(ctx, call.id, name, 'start', clip(call.function.arguments, 200))

        let args: Record<string, unknown> | null = null
        let parseError: string | null = null
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err)
          parseErrorThisIteration = true
        }

        let outcome: { result: string; sourceIds?: number[]; failed: boolean }
        if (args === null) {
          outcome = {
            result: `Error: tool arguments are not valid JSON (${parseError}). Retry the call with corrected JSON.`,
            failed: true
          }
        } else {
          try {
            const execution = await executeTool(name, args, toolCtx)
            outcome = { ...execution, result: clip(execution.result, TOOL_RESULT_LIMIT), failed: false }
          } catch (err) {
            // A Stop mid-fetch surfaces as an AbortError — finalize, don't persist it.
            if (controller.signal.aborted) throw new Error('aborted')
            // Malformed args are a model fault like unparseable call JSON —
            // they share the two-strike rule (give up only after the model
            // saw the corrective result and still failed).
            if (err instanceof InvalidToolArgsError) parseErrorThisIteration = true
            outcome = { result: `Error: ${err instanceof Error ? err.message : String(err)}`, failed: true }
          }
        }

        stream.add({
          type: 'tool_result',
          toolCallId: call.id,
          name,
          result: outcome.result,
          sourceIds: outcome.sourceIds
        })
        this.toolEvent(ctx, call.id, name, outcome.failed ? 'error' : 'result', clip(outcome.result, 200))
        if (encodesToolHistoryAsText(family)) {
          resultTexts.push(`[tool_result ${name}] ${outcome.result}`)
        } else {
          messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.result })
        }
      }

      if (encodesToolHistoryAsText(family)) {
        messages.push({
          role: 'user',
          content:
            `${resultTexts.join('\n\n')}\n\n` +
            'Use these tool results to continue answering the original question. ' +
            'Cite sources with their [n] markers where applicable. Do not repeat a tool call you already made.'
        })
      }
      // Give up only after the model saw the corrective result and still failed.
      if (parseErrorThisIteration && parseErrorLastIteration) {
        throw new Error('model kept producing malformed tool calls')
      }
      parseErrorLastIteration = parseErrorThisIteration
    }

    return { tokensIn, tokensOut }
  }

  private toolEvent(
    ctx: RunContext,
    toolCallId: string,
    name: string,
    phase: 'start' | 'result' | 'error',
    detail?: string
  ): void {
    this.deps.broadcast({
      type: 'chat.toolEvent',
      conversationId: ctx.conversationId,
      messageId: ctx.assistantMessageId,
      toolCallId,
      name,
      phase,
      detail
    })
  }

  // --- model resolution -----------------------------------------------------------

  /** Context window of the tier's active model; null when nothing is installed. */
  contextForTier(tier: Tier): number | null {
    try {
      return this.deps.modelService.contextLengthFor(this.resolveModel(tier))
    } catch {
      return null
    }
  }

  /** Requested tier first, then nearest installed below, then above. */
  private resolveModel(tier: Tier): string {
    return this.deps.modelService.resolveActiveRepo(tier)
  }

  private ensureModelLoaded(modelId: string): Promise<void> {
    return this.deps.modelService.ensureLoaded(modelId)
  }

  // --- message assembly --------------------------------------------------------------

  private buildHistory(
    path: Array<{ role: string; parts: MessagePart[] }>,
    family: ModelFamily,
    vision: boolean,
    promptOpts: Parameters<typeof buildSystemPrompt>[0]
  ): ChatCompletionMessage[] {
    const messages: ChatCompletionMessage[] = [
      { role: 'system', content: buildSystemPrompt(promptOpts) }
    ]
    for (const message of path) {
      if (message.role === 'user') {
        messages.push(this.userMessage(message.parts, vision))
      } else if (message.role === 'assistant') {
        messages.push(...this.assistantMessages(message.parts, family))
      }
    }
    return messages
  }

  private userMessage(parts: MessagePart[], vision: boolean): ChatCompletionMessage {
    const texts: string[] = []
    const images: ChatContentPart[] = []
    for (const part of parts) {
      if (part.type === 'text') texts.push(part.text)
      else if (part.type === 'image') {
        if (!vision) {
          texts.push('[An image was attached, but the current model cannot see images.]')
          continue
        }
        try {
          const data = readFileSync(part.path).toString('base64')
          images.push({ type: 'image_url', image_url: { url: `data:${part.mime};base64,${data}` } })
        } catch {
          texts.push('[An attached image could not be read from disk.]')
        }
      }
    }
    const text = texts.join('\n\n')
    if (images.length === 0) return { role: 'user', content: text }
    return { role: 'user', content: [...images, { type: 'text', text }] }
  }

  /**
   * Replay a persisted assistant turn. Thought parts NEVER go back to the
   * model; tool round-trips become OpenAI tool messages — or plain text for
   * families still configured for text encoding (see family.ts).
   */
  private assistantMessages(parts: MessagePart[], family: ModelFamily): ChatCompletionMessage[] {
    const asText = encodesToolHistoryAsText(family)
    const messages: ChatCompletionMessage[] = []
    let textBuffer: string[] = []
    let calls: Array<{ part: Extract<MessagePart, { type: 'tool_call' }> }> = []
    let results: Array<Extract<MessagePart, { type: 'tool_result' }>> = []

    const flushRound = (): void => {
      if (calls.length === 0 && textBuffer.length === 0) return
      const text = textBuffer.join('\n\n').trim()
      if (calls.length === 0) {
        if (text) messages.push({ role: 'assistant', content: text })
      } else if (asText) {
        const callText = calls
          .map((c) => `[tool_call] ${c.part.name}(${c.part.args})`)
          .join('\n')
        messages.push({ role: 'assistant', content: [text, callText].filter(Boolean).join('\n\n') })
        if (results.length > 0) {
          messages.push({
            role: 'user',
            content: results.map((r) => `[tool_result ${r.name}] ${r.result}`).join('\n\n')
          })
        }
      } else {
        messages.push({
          role: 'assistant',
          content: text || null,
          tool_calls: calls.map((c) => ({
            id: c.part.id,
            type: 'function',
            function: { name: c.part.name, arguments: c.part.args }
          }))
        })
        for (const r of results) {
          messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.result })
        }
      }
      textBuffer = []
      calls = []
      results = []
    }

    for (const part of parts) {
      if (part.type === 'sources' || part.type === 'image') continue
      if (part.type === 'thought') {
        // Each tool round opens with a thought (gemma emits no visible text
        // between rounds) — flush so rounds replay as call→result→call, not batched.
        if (calls.length > 0) flushRound()
        continue
      }
      if (part.type === 'text') {
        // Text after tool results starts the next round of the loop.
        if (calls.length > 0) flushRound()
        textBuffer.push(part.text)
      } else if (part.type === 'tool_call') {
        calls.push({ part })
      } else {
        results.push(part)
      }
    }
    flushRound()
    return messages
  }

  // --- attachments -----------------------------------------------------------------------

  private async prepareUserParts(
    text: string,
    attachments: AttachmentInput[],
    collectionId: string | null
  ): Promise<{
    parts: MessagePart[]
    attachments: Array<{
      kind: 'image' | 'document'
      path: string
      mime: string | null
      libraryDocId?: string | null
    }>
  }> {
    const parts: MessagePart[] = [{ type: 'text', text }]
    const rows: Array<{
      kind: 'image' | 'document'
      path: string
      mime: string | null
      libraryDocId?: string | null
    }> = []

    for (const att of attachments) {
      if (att.kind === 'image') {
        const ext = extname(att.path).toLowerCase()
        const mime = IMAGE_MIMES[ext]
        if (!mime) throw new Error(`Unsupported image type: ${ext || att.path}`)
        const copied = join(this.attachmentsDir, `${crypto.randomUUID()}${ext}`)
        copyFileSync(att.path, copied)
        parts.push({ type: 'image', path: copied, mime })
        rows.push({ kind: 'image', path: copied, mime })
        continue
      }

      const extracted = await this.deps.tools.extract({ path: att.path })
      const title = extracted.title ?? basename(att.path)
      if (extracted.markdown.length <= INLINE_DOC_LIMIT) {
        parts.push({
          type: 'text',
          text: `Attached document "${title}":\n\n\`\`\`\n${extracted.markdown}\n\`\`\``
        })
        rows.push({ kind: 'document', path: att.path, mime: null })
      } else if (collectionId) {
        const docId = this.deps.library.ingest({ collectionId, path: att.path })
        parts.push({
          type: 'text',
          text: `[Attached "${title}" — too large to inline, ingesting into the conversation's collection. Use rag_search to query it.]`
        })
        rows.push({ kind: 'document', path: att.path, mime: null, libraryDocId: docId })
      } else {
        // No collection to ingest into — inline what fits and say so.
        parts.push({
          type: 'text',
          text: `Attached document "${title}" (truncated to the first ${INLINE_DOC_LIMIT} characters — attach a collection to search the whole file):\n\n\`\`\`\n${clip(extracted.markdown, INLINE_DOC_LIMIT)}\n\`\`\``
        })
        rows.push({ kind: 'document', path: att.path, mime: null })
      }
    }
    return { parts, attachments: rows }
  }

  // --- titles ----------------------------------------------------------------------------

  /** Fire-and-forget after the first completed exchange, on the LOW tier model. */
  private async maybeGenerateTitle(conversationId: string): Promise<void> {
    const conversation = this.deps.repo.getConversation(conversationId)

    const path = this.deps.repo.activePath(conversationId)
    const textOf = (parts: MessagePart[]): string =>
      parts
        .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
    const firstUserParts = path.find((m) => m.role === 'user')?.parts ?? []
    const userText = textOf(firstUserParts)
    const assistantText = textOf(path.findLast((m) => m.role === 'assistant')?.parts ?? [])
    if (!userText || !assistantText) return

    // Refine only the instant truncated title — never overwrite a user rename
    // or an earlier refinement. Compare against the FIRST text part alone:
    // prepareUserParts appends extra text parts for document attachments,
    // which never fed the instant title.
    const rawUserText =
      firstUserParts.find(
        (p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text'
      )?.text ?? ''
    if (conversation.title !== 'New chat' && conversation.title !== instantTitle(rawUserText)) {
      return
    }

    const overview = this.deps.modelService.overview()
    const lowModel = overview.tiers.find((t) => t.tier === 'low')?.active
    if (!lowModel) return
    // Never trigger a model load just for a title: refine opportunistically
    // while the low model is already resident.
    const lowLoaded =
      overview.engine.running &&
      overview.engine.models.some((m) => m.id === lowModel && m.state === 'loaded')
    if (!lowLoaded) return

    // Title generation goes through EngineClient too — inflight stays truthful.
    const startedAt = Date.now()
    const messages = titleMessages(userText, assistantText)
    let raw = ''
    for await (const event of this.deps.engine.streamChat({
      model: lowModel,
      messages,
      maxTokens: 200 // thinking tokens count against max_tokens before the title
    })) {
      if (event.type === 'content') raw += event.text
    }
    const title = cleanTitle(stripThoughts(raw, familyOf(lowModel)))
    traceLlm({
      surface: 'chat',
      step: 'title',
      conversationId,
      model: lowModel,
      messages,
      output: raw,
      ok: title.length > 0,
      ms: Date.now() - startedAt
    })
    if (!title) return
    this.deps.repo.setTitle(conversationId, title)
    this.deps.broadcast({ type: 'chat.titleChanged', conversationId, title })
  }
}
