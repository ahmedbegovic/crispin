import { describe, expect, it } from 'vitest'
import { BUDGETS, budgetFor } from './search-pipeline'
import { DEFAULT_SCOPE, SEARCH_SCOPES, inferScopeFromQueries } from './search-router-core'

describe('inferScopeFromQueries (scope omitted by the router)', () => {
  it('keeps the default band for 1-2 queries', () => {
    expect(inferScopeFromQueries(1)).toBe(DEFAULT_SCOPE)
    expect(inferScopeFromQueries(2)).toBe(DEFAULT_SCOPE)
  })

  it('widens so the router’s queries are not clipped away', () => {
    expect(inferScopeFromQueries(3)).toBe('comparison')
    expect(inferScopeFromQueries(5)).toBe('deep_research')
    // the inferred band must run at least as many queries as the router wrote
    expect(BUDGETS[inferScopeFromQueries(3)].queries).toBeGreaterThanOrEqual(3)
    expect(BUDGETS[inferScopeFromQueries(5)].queries).toBeGreaterThanOrEqual(5)
  })
})

describe('search budget mapping', () => {
  it('resolves an omitted scope to the default band', () => {
    expect(budgetFor(undefined)).toBe(BUDGETS[DEFAULT_SCOPE])
    expect(budgetFor(null)).toBe(BUDGETS[DEFAULT_SCOPE])
  })

  it('resolves each named scope to its own budget', () => {
    for (const scope of SEARCH_SCOPES) {
      expect(budgetFor(scope)).toBe(BUDGETS[scope])
    }
  })

  it('keeps deep_research at the old fixed-pipeline values (no-regression floor)', () => {
    // The pre-revamp constants: RESULTS_PER_QUERY=6, MAX_VISITS=5,
    // MIN_GOOD_VISITS=3, ADAPTIVE_MAX_ROUNDS=3, ADAPTIVE_BATCH=4, MAX_TOTAL_VISITS=12.
    expect(BUDGETS.deep_research).toEqual({
      queries: 5,
      resultsPerQuery: 6,
      minGoodVisits: 3,
      maxVisits: 5,
      adaptiveRounds: 3,
      adaptiveBatch: 4,
      maxTotalVisits: 12
    })
  })

  it('makes quick_lookup the lightest band — the "why always 6?" fix', () => {
    const q = BUDGETS.quick_lookup
    expect(q.resultsPerQuery).toBeLessThan(BUDGETS.deep_research.resultsPerQuery)
    expect(q.queries).toBe(1)
    expect(q.adaptiveRounds).toBe(0)
    for (const scope of SEARCH_SCOPES) {
      expect(q.maxTotalVisits).toBeLessThanOrEqual(BUDGETS[scope].maxTotalVisits)
    }
  })

  it('every budget is internally consistent', () => {
    for (const scope of SEARCH_SCOPES) {
      const b = BUDGETS[scope]
      expect(b.queries).toBeGreaterThanOrEqual(1)
      expect(b.resultsPerQuery).toBeGreaterThanOrEqual(1)
      expect(b.maxVisits).toBeGreaterThanOrEqual(1)
      expect(b.minGoodVisits).toBeGreaterThanOrEqual(0)
      expect(b.minGoodVisits).toBeLessThanOrEqual(b.maxVisits)
      // The total ceiling can never undercut the first read batch.
      expect(b.maxTotalVisits).toBeGreaterThanOrEqual(b.maxVisits)
    }
  })

  it('defaults to a band lighter than the widest (omission must not over-crawl)', () => {
    expect(BUDGETS[DEFAULT_SCOPE].maxTotalVisits).toBeLessThan(BUDGETS.deep_research.maxTotalVisits)
  })
})
