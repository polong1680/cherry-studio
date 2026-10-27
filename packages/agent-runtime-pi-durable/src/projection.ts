import { randomUUID } from 'node:crypto'

import type { ConversationView, ConversationWatch, LiveState } from '@earendil-works/pi-durable'

import { ThreadFeed, type Thread } from '@cherrystudio/agent-runtime'

import { ContentProjection, entryItemId } from './content'

/** One normalized source shared by every access to a native conversation. */
export class DurableProjection {
  readonly feed: ThreadFeed
  private readonly epoch = randomUUID()
  private previews = new Map<string, { task: number; after: number; role: 'assistant' | 'toolResult' }>()
  readonly aliases: Record<string, string> = {}

  constructor(
    readonly ref: Thread,
    private readonly watch: ConversationWatch,
    report: (error: unknown) => void
  ) {
    this.feed = new ThreadFeed(
      {
        type: 'snapshot',
        coverage: 'current-view',
        items: [],
        inputs: [],
        subagents: [],
        activity: { scope: 'foreground', state: 'unknown' }
      },
      report
    )
    this.update(watch.value)
    watch.start(async (value) => this.update(value))
    void watch.closed.then((end) => {
      if (end.reason === 'stopped' || end.reason === 'session_closed') return
      if ('error' in end) report(end.error)
      this.feed.publish({ type: 'gap', reason: 'disconnected' })
      this.feed.close('source-lost')
    })
  }

  async close(): Promise<void> {
    this.feed.close('shutdown')
    await this.watch.stop()
  }

  private update(view: ConversationView): void {
    const live = view.docs['pi.live'] as LiveState | undefined
    const content = new ContentProjection(this.ref)
    const previews: typeof this.previews = new Map()
    for (const entry of view.entries) content.entry(entry)
    const after = view.entries.reduce((latest, entry) => Math.max(latest, entry.id), 0)
    const generation = live?.generation
    const nextLiveId =
      generation?.message && live?.run ? `live:${this.epoch}:${live.run.taskId}:${generation.attempt}` : undefined
    if (generation?.message && nextLiveId) {
      previews.set(nextLiveId, { task: live!.run!.taskId, after, role: 'assistant' })
      content.message(generation.message, nextLiveId, 'partial')
    }
    for (const slot of live?.tools ?? []) {
      if (slot.output !== undefined && slot.taskId && !slot.entry) {
        const id = `tool-progress:${this.epoch}:${slot.taskId}`
        previews.set(id, { task: slot.taskId, after, role: 'toolResult' })
        content.progress(id, slot.callId, slot.output)
      }
    }
    let reset = false
    for (const [id, preview] of this.previews) {
      if (previews.has(id)) {
        previews.set(id, preview)
        continue
      }
      const candidates = view.entries.flatMap((entry) =>
        entry.byTaskId === preview.task && entry.id > preview.after
          ? (entry.model ?? []).flatMap((message, index) => (message.role === preview.role ? [{ entry, index }] : []))
          : []
      )
      if (candidates.length !== 1) {
        reset = true
        continue
      }
      const { entry, index } = candidates[0]
      const committed = entryItemId(entry, index)
      this.aliases[committed] = id
      for (const item of content.items)
        if (item.ref.id.startsWith(`${committed}:call:`))
          this.aliases[item.ref.id] = `${id}${item.ref.id.slice(committed.length)}`
    }
    if (reset) this.feed.publish({ type: 'gap', reason: 'mapping-reset' })
    this.previews = previews
    this.feed.publish({
      ...this.feed.snapshot,
      items: content.items,
      activity: { scope: 'foreground', state: live?.run ? 'active' : 'idle' }
    })
  }
}
