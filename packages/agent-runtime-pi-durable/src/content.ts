import type { Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'

import {
  runtimeId,
  type ContentItem,
  type ContentPart,
  type ItemRef,
  type JsonValue,
  type Thread
} from '@cherrystudio/agent-runtime'

/** Stable committed identities; consumers never decode native entry IDs from these keys. */
export const entryItemId = (entry: EntryRecord, index: number): string => `entry:${entry.id}:${index}`

export class ContentProjection {
  readonly items: ContentItem[] = []
  private readonly calls = new Map<string, ItemRef>()

  constructor(private readonly thread: Thread) {}

  ref(id: string): ItemRef {
    return { session: this.thread, id: runtimeId(id) }
  }

  entry(entry: EntryRecord): void {
    for (const [index, message] of (entry.model ?? []).entries()) {
      this.message(message, entryItemId(entry, index), 'complete')
      const inputId = (entry.data as { cherryInputId?: string })?.cherryInputId
      if (message.role === 'user' && inputId) {
        const item = this.items.at(-1)!
        if (item.type === 'message') this.items[this.items.length - 1] = { ...item, inputId: runtimeId(inputId) }
      }
    }
  }

  message(message: Message, id: string, completeness: 'partial' | 'complete'): void {
    if (message.role === 'system') return
    const parts: ContentPart[] = []
    const toolCalls: ContentItem[] = []
    if (typeof message.content === 'string') parts.push({ type: 'text', text: message.content })
    else
      for (const part of message.content) {
        if (part.type === 'text') parts.push({ type: 'text', text: part.text })
        if (part.type === 'thinking') parts.push({ type: 'reasoning', text: part.thinking })
        if (part.type === 'toolCall') {
          const ref = this.ref(`${id}:call:${part.id}`)
          this.calls.set(part.id, ref)
          toolCalls.push({
            ref,
            type: 'tool-call',
            name: part.name,
            argumentsText: JSON.stringify(part.arguments),
            completeness
          })
        }
      }
    if (message.role === 'toolResult')
      this.items.push({
        ref: this.ref(id),
        type: 'tool-result',
        call: this.calls.get(message.toolCallId),
        parts,
        outcome: message.isError ? 'error' : 'success',
        data: {
          content: message.content.map(
            (part): JsonValue =>
              part.type === 'text'
                ? { type: 'text', text: part.text }
                : { type: 'image', data: part.data, mimeType: part.mimeType }
          ),
          ...(message.details !== undefined && { details: message.details }),
          isError: message.isError
        }
      })
    else this.items.push({ ref: this.ref(id), type: 'message', role: message.role, parts, completeness })
    this.items.push(...toolCalls)
  }

  progress(id: string, callId: string, text: string): void {
    this.items.push({
      ref: this.ref(id),
      type: 'tool-result',
      call: this.calls.get(callId),
      parts: [{ type: 'text', text }],
      outcome: 'unknown'
    })
  }
}
