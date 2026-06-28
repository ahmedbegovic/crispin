import { z } from 'zod'
import {
  appSettingsSchema,
  featureSchema,
  tierSchema,
  type AppSettings,
  type CrispinEvent
} from '@shared/ipc'
import { defaultModulesEnabled } from '@shared/modules'
import { canonicalRepoId } from '@shared/model-tiers'
import type { Family, Feature, Tier } from '@shared/types'
import type { CrispinDatabase } from './db'
import * as settings from './settings'
import { parseArrayDropInvalid, parseOr, parseRecordDropInvalid } from './hydrate'

/** One knob for both the main-side idle sweep and the oMLX TTL backstop. */
export const DEFAULT_IDLE_UNLOAD_SECONDS = 300

const DEFAULT_PROFILE = { userName: '', assistantName: 'Crispin' }
const DEFAULT_INSTRUCTIONS: AppSettings['instructions'] = { global: '', perModule: {} }

/** Persisted picks survive curated-id renames: map old ids forward on read. */
const normalizeTierSelections = (
  raw: Partial<Record<Tier, string>>
): Partial<Record<Tier, string>> => {
  const out: Partial<Record<Tier, string>> = {}
  for (const [tier, repoId] of Object.entries(raw)) {
    if (repoId) out[tier as Tier] = canonicalRepoId(repoId)
  }
  return out
}

export interface AppSettingsServiceDeps {
  db: CrispinDatabase
  broadcast: (event: CrispinEvent) => void
  /** Fired when a spawn-time engine setting (moeOffloadGB) changes, so the engine
   *  can be restarted to apply it (otherwise it would ride an unrelated respawn). */
  onMoeOffloadChange?: () => void
}

/**
 * Assembles the Settings page's full object from per-area `settings` table
 * keys (and disassembles it on update). Main-side consumers read through the
 * typed helpers; the renderer gets the whole object plus `settings.changed`.
 */
export class AppSettingsService {
  constructor(private readonly deps: AppSettingsServiceDeps) {}

  get(): AppSettings {
    const db = this.deps.db
    // Validate each stored value against its contract slice, degrading at the
    // FINEST granularity the value allows: scalars/atomic objects → fall back to
    // their default; arrays → drop only the bad elements; records → drop only the
    // bad entries. So a stale module/tier key or one corrupt element can never
    // collapse a whole map (and a get→update round-trip can't persist that loss).
    const shape = appSettingsSchema.shape
    const rawInstructions = settings.get<{ global?: unknown; perModule?: unknown }>(
      db,
      'instructions',
      DEFAULT_INSTRUCTIONS
    )
    return {
      profile: parseOr(
        shape.profile,
        settings.get(db, 'profile', DEFAULT_PROFILE),
        DEFAULT_PROFILE,
        'settings.profile'
      ),
      // global and perModule degrade independently — a stale perModule key must
      // not take down the user's global instruction.
      instructions: {
        global: parseOr(z.string(), rawInstructions?.global, '', 'settings.instructions.global'),
        perModule: parseRecordDropInvalid(
          featureSchema,
          z.string(),
          rawInstructions?.perModule,
          'settings.instructions.perModule'
        )
      },
      // Cast: the defaults spread guarantees every value is a boolean; the
      // drop-invalid overlay only ever adds booleans, but Partial<> widens the
      // spread's index type to boolean|undefined.
      modulesEnabled: {
        ...defaultModulesEnabled(),
        ...parseRecordDropInvalid(
          z.string(),
          z.boolean(),
          settings.get(db, 'modules.enabled', {}),
          'settings.modulesEnabled'
        )
      } as Record<string, boolean>,
      idleUnloadSeconds: parseOr(
        shape.idleUnloadSeconds,
        settings.get(db, 'models.idleUnloadSeconds', DEFAULT_IDLE_UNLOAD_SECONDS),
        DEFAULT_IDLE_UNLOAD_SECONDS,
        'settings.idleUnloadSeconds'
      ),
      newsTopics: parseArrayDropInvalid(
        z.string(),
        settings.get(db, 'news.topics', []),
        'settings.newsTopics'
      ),
      tierSelections: normalizeTierSelections(
        parseRecordDropInvalid(
          tierSchema,
          z.string(),
          settings.get(db, 'models.tierSelections', {}),
          'settings.tierSelections'
        )
      ),
      defaultFamily: parseOr(
        shape.defaultFamily,
        settings.get(db, 'models.defaultFamily', 'gemma'),
        'gemma',
        'settings.defaultFamily'
      ),
      moeOffloadGB: parseOr(
        shape.moeOffloadGB,
        settings.get(db, 'engine.moeOffloadGB', 0),
        0,
        'settings.moeOffloadGB'
      ),
      moeOffloadOptimistic: parseOr(
        shape.moeOffloadOptimistic,
        settings.get(db, 'engine.moeOffloadOptimistic', false),
        false,
        'settings.moeOffloadOptimistic'
      )
    }
  }

  update(next: AppSettings): void {
    const db = this.deps.db
    const prev = this.get()
    settings.set(db, 'profile', next.profile)
    settings.set(db, 'instructions', next.instructions)
    settings.set(db, 'modules.enabled', next.modulesEnabled)
    settings.set(db, 'models.idleUnloadSeconds', next.idleUnloadSeconds)
    settings.set(db, 'news.topics', next.newsTopics)
    settings.set(db, 'models.tierSelections', next.tierSelections)
    settings.set(db, 'models.defaultFamily', next.defaultFamily)
    settings.set(db, 'engine.moeOffloadGB', next.moeOffloadGB)
    settings.set(db, 'engine.moeOffloadOptimistic', next.moeOffloadOptimistic)
    this.deps.broadcast({ type: 'settings.changed', settings: this.get() })
    // Spawn-time engine knobs (both ride OMLX_MOE_* env at spawn, not the live
    // model_settings path): restart the engine when either changes so it applies.
    if (
      next.moeOffloadGB !== prev.moeOffloadGB ||
      next.moeOffloadOptimistic !== prev.moeOffloadOptimistic
    ) {
      this.deps.onMoeOffloadChange?.()
    }
  }

  profile(): AppSettings['profile'] {
    return this.get().profile
  }

  /** Trimmed per-module instruction, '' when unset. */
  moduleInstruction(module: Feature): string {
    return this.get().instructions.perModule[module]?.trim() ?? ''
  }

  globalInstruction(): string {
    return this.get().instructions.global.trim()
  }

  moduleEnabled(moduleId: string): boolean {
    const enabled = this.get().modulesEnabled
    return enabled[moduleId] ?? true
  }

  idleUnloadSeconds(): number {
    return this.get().idleUnloadSeconds
  }

  newsTopics(): string[] {
    return this.get().newsTopics
  }

  tierSelections(): AppSettings['tierSelections'] {
    return this.get().tierSelections
  }

  defaultFamily(): Family {
    return this.get().defaultFamily
  }
}
