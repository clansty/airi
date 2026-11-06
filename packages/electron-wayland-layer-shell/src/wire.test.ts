import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { ArgumentReader, buildMessage, parseMessages } from './wire'

describe('wire', () => {
  it('round-trips numbers, strings and arrays', () => {
    const message = buildMessage(7, 3, [42, 'hello', Buffer.from([1, 2, 3])])
    const { messages, rest } = parseMessages(message)

    expect(rest.length).toBe(0)
    expect(messages).toHaveLength(1)
    expect(messages[0].objectId).toBe(7)
    expect(messages[0].opcode).toBe(3)

    const reader = new ArgumentReader(messages[0].payload)
    expect(reader.uint()).toBe(42)
    expect(reader.string()).toBe('hello')
    expect([...reader.array()]).toEqual([1, 2, 3])
    expect(reader.remaining).toBe(0)
  })

  it('keeps a partial message for the next read', () => {
    const message = buildMessage(2, 1, ['a longer string to split'])
    const { messages, rest } = parseMessages(message.subarray(0, 12))

    expect(messages).toHaveLength(0)
    expect(rest.length).toBe(12)
  })

  it('splits several messages in one chunk', () => {
    const chunk = Buffer.concat([buildMessage(1, 2, []), buildMessage(3, 4, [5])])
    const { messages } = parseMessages(chunk)

    expect(messages.map(message => [message.objectId, message.opcode])).toEqual([[1, 2], [3, 4]])
  })

  it('reads fixed point numbers', () => {
    const message = buildMessage(1, 1, [1280])
    const reader = new ArgumentReader(message.subarray(8))
    expect(reader.fixed()).toBe(5)
  })
})
