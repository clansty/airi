import { Buffer } from 'node:buffer'

/**
 * Wayland 线格式的编解码。
 *
 * 一条消息是 8 字节头（对象号 + 长度与 opcode）加参数；文件描述符不在流里，走 ancillary data。
 * 这里只做代理需要的事：切开消息、读参数、拼消息，不做完整的协议绑定。
 */

export interface WaylandMessage {
  objectId: number
  opcode: number
  /** 参数区，不含 8 字节头。 */
  payload: Buffer
  /** 整条消息，转发时原样写回。 */
  raw: Buffer
}

export interface ParsedMessages {
  messages: WaylandMessage[]
  /** 还没收全的尾巴，留给下一次读。 */
  rest: Buffer
}

/** 把流切成完整消息。半条消息留在 `rest` 里，因为一次读不一定正好读到消息边界。 */
export function parseMessages(buffer: Buffer): ParsedMessages {
  const messages: WaylandMessage[] = []
  let offset = 0

  while (buffer.length - offset >= 8) {
    const objectId = buffer.readUInt32LE(offset)
    const word = buffer.readUInt32LE(offset + 4)
    const size = word >>> 16
    const opcode = word & 0xFFFF

    // 长度小于 8 或者超出已读范围，说明流已经不可信了，交给调用方断开连接。
    if (size < 8)
      break
    if (offset + size > buffer.length)
      break

    messages.push({
      objectId,
      opcode,
      payload: buffer.subarray(offset + 8, offset + size),
      raw: buffer.subarray(offset, offset + size),
    })
    offset += size
  }

  return { messages, rest: buffer.subarray(offset) }
}

/** 消息长度是否合法（用于判断流有没有坏掉）。 */
export function isValidMessage(buffer: Buffer, offset = 0): boolean {
  if (buffer.length - offset < 8)
    return true
  return (buffer.readUInt32LE(offset + 4) >>> 16) >= 8
}

/** 参数类型：数字按 uint32 写，字符串带长度和 NUL 补齐，Buffer 当二进制数组写。 */
export type WaylandArgument = number | string | Buffer

/** 拼一条消息。参数里没有文件描述符，代理注入的消息都不带 fd。 */
export function buildMessage(objectId: number, opcode: number, args: WaylandArgument[] = []): Buffer {
  const parts: Buffer[] = []

  for (const arg of args) {
    if (typeof arg === 'number') {
      const word = Buffer.alloc(4)
      word.writeUInt32LE(arg >>> 0, 0)
      parts.push(word)
    }
    else if (typeof arg === 'string') {
      const encoded = Buffer.from(arg, 'utf8')
      const length = Buffer.alloc(4)
      // 长度含结尾的 NUL，NUL 本身也要写进去并参与补齐。
      length.writeUInt32LE(encoded.length + 1, 0)
      parts.push(length, encoded, Buffer.alloc(1 + padTo(encoded.length + 1)))
    }
    else {
      const length = Buffer.alloc(4)
      length.writeUInt32LE(arg.length, 0)
      parts.push(length, arg, Buffer.alloc(padTo(arg.length)))
    }
  }

  const payload = Buffer.concat(parts)
  const header = Buffer.alloc(8)
  header.writeUInt32LE(objectId >>> 0, 0)
  header.writeUInt32LE((((payload.length + 8) << 16) | (opcode & 0xFFFF)) >>> 0, 4)

  return Buffer.concat([header, payload])
}

function padTo(length: number): number {
  return (4 - (length % 4)) % 4
}

/** 按顺序读一条消息的参数。 */
export class ArgumentReader {
  private offset = 0

  constructor(private readonly payload: Buffer) {}

  uint(): number {
    const value = this.payload.readUInt32LE(this.offset)
    this.offset += 4
    return value
  }

  int(): number {
    const value = this.payload.readInt32LE(this.offset)
    this.offset += 4
    return value
  }

  /** 24.8 定点数。 */
  fixed(): number {
    return this.int() / 256
  }

  object(): number {
    return this.uint()
  }

  string(): string {
    const length = this.uint()
    const value = this.payload.toString('utf8', this.offset, this.offset + length - 1)
    this.offset += length + padTo(length)
    return value
  }

  array(): Buffer {
    const length = this.uint()
    const value = this.payload.subarray(this.offset, this.offset + length)
    this.offset += length + padTo(length)
    return value
  }

  get remaining(): number {
    return this.payload.length - this.offset
  }
}
