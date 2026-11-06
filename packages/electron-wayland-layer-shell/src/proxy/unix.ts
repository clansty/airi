/**
 * 直接对着 libc 收发 unix socket 的字节。
 *
 * 为什么不用 `node:net`：Wayland 的缓冲区要在消息里带文件描述符，Node 的 socket 没有 SCM_RIGHTS。
 * 只有 `recvmsg`/`sendmsg` 能做这件事，所以这里用 koffi 调 libc，自己拿 fd 做 I/O。
 * 全部调用都在代理进程里同步阻塞，代理不跑事件循环，因此不会挡住任何人。
 */
import { Buffer } from 'node:buffer'

import koffi from 'koffi'

const libc = koffi.load('libc.so.6')

const IOVec = koffi.struct('iovec', {
  base: 'void *',
  len: 'size_t',
})

const MsgHdr = koffi.struct('msghdr', {
  name: 'void *',
  namelen: 'uint32',
  iov: koffi.pointer(IOVec),
  iovlen: 'size_t',
  control: 'void *',
  controllen: 'size_t',
  flags: 'int',
})

const PollFd = koffi.struct('pollfd', {
  fd: 'int',
  events: 'short',
  revents: 'short',
})

const call = {
  socket: libc.func('int socket(int domain, int type, int protocol)'),
  bind: libc.func('int bind(int fd, const void *addr, uint32_t addrlen)'),
  listen: libc.func('int listen(int fd, int backlog)'),
  accept: libc.func('int accept(int fd, void *addr, uint32_t *addrlen)'),
  connect: libc.func('int connect(int fd, const void *addr, uint32_t addrlen)'),
  close: libc.func('int close(int fd)'),
  poll: libc.func('int poll(pollfd *fds, unsigned long nfds, int timeout)'),
  recvmsg: libc.func('long long recvmsg(int fd, msghdr *msg, int flags)'),
  sendmsg: libc.func('long long sendmsg(int fd, const msghdr *msg, int flags)'),
  unlink: libc.func('int unlink(const char *path)'),
  chmod: libc.func('int chmod(const char *path, uint32_t mode)'),
  fcntl: libc.func('int fcntl(int fd, int cmd, int arg)'),
}

const AF_UNIX = 1
const SOCK_STREAM = 1
const SOCK_CLOEXEC = 0o2000000
const SOL_SOCKET = 1
const SCM_RIGHTS = 1
const F_GETFL = 3
const F_SETFL = 4
const O_NONBLOCK = 0o4000
const MSG_DONTWAIT = 0x40

export const POLLIN = 0x1
export const POLLOUT = 0x4
/** poll 的 revents 里任何「需要处理」的位：可读、可写、对端关闭、出错。 */
export const POLL_ANY = POLLIN | POLLOUT | 0x8 | 0x10

/** sockaddr_un：2 字节地址族加 108 字节路径。 */
function sockaddrUn(path: string): Buffer {
  const buffer = Buffer.alloc(110)
  buffer.writeUInt16LE(AF_UNIX, 0)
  buffer.write(path, 2, 'utf8')
  return buffer
}

function setNonBlocking(fd: number): void {
  const flags = call.fcntl(fd, F_GETFL, 0)
  if (flags < 0)
    throw new Error('fcntl F_GETFL failed')
  if (call.fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
    throw new Error('fcntl F_SETFL failed')
}

/** 监听一个 unix socket。同名旧文件先删掉，权限收到 0600。 */
export function createListener(path: string): number {
  call.unlink(path)
  const fd = call.socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0)
  if (fd < 0)
    throw new Error('socket() failed')

  const address = sockaddrUn(path)
  if (call.bind(fd, address, address.length) < 0) {
    call.close(fd)
    throw new Error(`bind() failed for ${path}`)
  }
  if (call.listen(fd, 64) < 0) {
    call.close(fd)
    throw new Error(`listen() failed for ${path}`)
  }

  call.chmod(path, 0o600)
  setNonBlocking(fd)
  return fd
}

export function connectUnix(path: string): number {
  const fd = call.socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0)
  if (fd < 0)
    throw new Error('socket() failed')

  const address = sockaddrUn(path)
  if (call.connect(fd, address, address.length) < 0) {
    call.close(fd)
    throw new Error(`connect() failed for ${path}`)
  }

  setNonBlocking(fd)
  return fd
}

/** 接受一个连接，没有连接时返回 -1。 */
export function acceptFd(listenFd: number): number {
  const fd = call.accept(listenFd, null, null)
  if (fd < 0)
    return -1
  setNonBlocking(fd)
  return fd
}

export function closeFd(fd: number): void {
  call.close(fd)
}

export function unlinkPath(path: string): void {
  call.unlink(path)
}

export interface PollResult {
  fd: number
  revents: number
}

export function poll(fds: { fd: number, events: number }[], timeoutMs: number): PollResult[] {
  if (fds.length === 0) {
    call.poll(null, 0, timeoutMs)
    return []
  }

  const size = koffi.sizeof(PollFd)
  const buffer = Buffer.alloc(size * fds.length)
  fds.forEach((entry, index) => {
    koffi.encode(buffer.subarray(index * size), PollFd, { fd: entry.fd, events: entry.events, revents: 0 })
  })

  const ready = call.poll(buffer, fds.length, timeoutMs)
  if (ready <= 0)
    return []

  const results: PollResult[] = []
  for (let index = 0; index < fds.length; index++) {
    const entry = koffi.decode(buffer.subarray(index * size), PollFd)
    if (entry.revents !== 0)
      results.push({ fd: entry.fd, revents: entry.revents })
  }
  return results
}

export interface ReceivedChunk {
  /** 读到 0 表示对端关了；读到 -1 表示这一瞬间没有数据。 */
  bytes: number
  data: Buffer
  fds: number[]
}

const CMSG_HEADER_SIZE = 16
const CMSG_CHUNK = 24

/** 读一次，连带把 ancillary data 里的 fd 取出来。 */
export function recvWithFds(fd: number, maxBytes = 1 << 16): ReceivedChunk {
  const data = Buffer.alloc(maxBytes)
  const iov = Buffer.alloc(koffi.sizeof(IOVec))
  koffi.encode(iov, IOVec, { base: data, len: maxBytes })

  const control = Buffer.alloc(CMSG_CHUNK * 8)
  const header = Buffer.alloc(koffi.sizeof(MsgHdr))
  koffi.encode(header, MsgHdr, { name: null, namelen: 0, iov, iovlen: 1, control, controllen: control.length, flags: 0 })

  const bytes = call.recvmsg(fd, header, MSG_DONTWAIT)
  if (bytes <= 0)
    return { bytes, data: Buffer.alloc(0), fds: [] }

  const received = koffi.decode(header, MsgHdr)
  const fds: number[] = []
  let offset = 0
  while (offset + CMSG_HEADER_SIZE <= received.controllen) {
    const length = Number(control.readBigUInt64LE(offset))
    if (length < CMSG_HEADER_SIZE)
      break

    const level = control.readUInt32LE(offset + 8)
    const type = control.readUInt32LE(offset + 12)
    if (level === SOL_SOCKET && type === SCM_RIGHTS) {
      for (let at = offset + CMSG_HEADER_SIZE; at + 4 <= offset + length; at += 4)
        fds.push(control.readInt32LE(at))
    }

    offset += Math.ceil(length / 8) * 8
  }

  return { bytes, data: data.subarray(0, bytes), fds }
}

/**
 * 写一次。返回写进去的字节数，-1 表示暂时写不进去。
 *
 * fd 跟着这一批字节走。对端解析时会按顺序把它们分给需要 fd 的消息，所以只要顺序不变，切在哪条消息上都行。
 */
export function sendWithFds(fd: number, data: Buffer, fds: readonly number[] = []): number {
  if (data.length === 0 && fds.length === 0)
    return 0

  // 只带 fd 不带字节的写：iov 长度给 0 更容易被内核当成空写，所以塞一个字节的占位。
  const payload = data.length === 0 ? Buffer.alloc(1) : data
  const iov = Buffer.alloc(koffi.sizeof(IOVec))
  koffi.encode(iov, IOVec, { base: payload, len: data.length })

  let control: Buffer | null = null
  let controlLength = 0
  if (fds.length > 0) {
    controlLength = CMSG_HEADER_SIZE + Math.ceil((fds.length * 4) / 8) * 8
    control = Buffer.alloc(controlLength)
    control.writeBigUInt64LE(BigInt(CMSG_HEADER_SIZE + fds.length * 4), 0)
    control.writeUInt32LE(SOL_SOCKET, 8)
    control.writeUInt32LE(SCM_RIGHTS, 12)
    fds.forEach((entry, index) => control!.writeInt32LE(entry, CMSG_HEADER_SIZE + index * 4))
  }

  const header = Buffer.alloc(koffi.sizeof(MsgHdr))
  koffi.encode(header, MsgHdr, { name: null, namelen: 0, iov, iovlen: 1, control, controllen: controlLength, flags: 0 })

  return call.sendmsg(fd, header, MSG_DONTWAIT)
}
