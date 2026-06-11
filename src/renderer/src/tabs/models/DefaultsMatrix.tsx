import { TIER_LABELS, TIER_ORDER } from '@shared/model-tiers'
import type { Feature, ModelsOverview, Tier } from '@shared/types'
import { useModelsStore } from '@/stores/models'

const FEATURES: Feature[] = ['chat', 'agent', 'code', 'research', 'news']

/** Feature -> tier mapping. Persisted in settings by the main process. */
export default function DefaultsMatrix({ overview }: { overview: ModelsOverview }) {
  const setDefault = useModelsStore((s) => s.setDefault)

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Feature defaults
      </h2>
      <div className="grid grid-cols-5 gap-3">
        {FEATURES.map((feature) => (
          <label key={feature} className="flex flex-col gap-1">
            <span className="text-[11px] capitalize text-zinc-500">{feature}</span>
            <select
              value={overview.defaults[feature]}
              onChange={(e) => {
                // The store reverts the optimistic value on failure; the
                // select snapping back is the error surface.
                setDefault(feature, e.target.value as Tier).catch(() => {})
              }}
              className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[12px] text-zinc-200 outline-none focus:border-zinc-600"
            >
              {TIER_ORDER.map((tier) => (
                <option key={tier} value={tier}>
                  {TIER_LABELS[tier]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">Which tier each feature uses.</p>
    </section>
  )
}
