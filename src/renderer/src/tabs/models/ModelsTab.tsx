import { useEffect } from 'react'
import { useModelsStore } from '@/stores/models'
import RamMeter from './RamMeter'
import TierGrid from './TierGrid'
import DefaultsMatrix from './DefaultsMatrix'
import DownloadsPanel from './DownloadsPanel'
import LocalModels from './LocalModels'
import HFSearch from './HFSearch'

export default function ModelsTab() {
  const overview = useModelsStore((s) => s.overview)
  const init = useModelsStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="h-full overflow-y-auto">
      {/* In-band sticky header: h-12 row shares the hiddenInset titlebar band and drags the window. */}
      <header className="drag-region sticky top-0 z-10 border-b border-zinc-800/80 bg-[#101013]">
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between gap-6 px-8">
          <h1 className="text-[13px] font-semibold text-zinc-100">Models</h1>
          {overview && <RamMeter ram={overview.ram} />}
        </div>
      </header>
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-8 pb-12 pt-6">
        {overview ? (
          <>
            <TierGrid overview={overview} />
            <DefaultsMatrix overview={overview} />
            <DownloadsPanel overview={overview} />
            <LocalModels overview={overview} />
            <HFSearch />
          </>
        ) : (
          <p className="text-sm text-zinc-600">Loading…</p>
        )}
      </div>
    </div>
  )
}
