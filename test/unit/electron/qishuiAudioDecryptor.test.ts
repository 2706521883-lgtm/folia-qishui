import { createRequire } from 'node:module'
import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type DecryptMeta = {
  isFlac: boolean
  sampleCount: number
  chunkCount: number
  sampleOffsetSource: string
}

type DecryptResult = {
  buffer: Buffer
  extension: string
  fileName: string
  meta: DecryptMeta
}

type DecryptInput = {
  encryptedBuffer: Buffer
  spadeA: string
  media?: Record<string, unknown>
}

const { TrackDecryptor } = require('../../../electron/qishui/qishui-audio-decryptor/track-decryptor.js') as {
  TrackDecryptor: new () => { decrypt: (input: DecryptInput) => DecryptResult }
}

const { computeSampleOffsets, parseCo64, parseStco } = require('../../../electron/qishui/qishui-audio-decryptor/decrypt-utils.js') as {
  computeSampleOffsets: (input: {
    sampleSizes: number[]
    stscEntries: Array<{ firstChunk: number; samplesPerChunk: number; id?: number }>
    chunkOffsets: number[]
  }) => number[]
  parseStco: (data: Buffer) => number[]
  parseCo64: (data: Buffer) => number[]
}

// AES-128-CTR 的 key 用 hex 直传，resolveKey 会走 hexToBuffer 分支。
const KEY_HEX = '00112233445566778899aabbccddeeff'
const KEY = Buffer.from(KEY_HEX, 'hex')

// 每个样本一个 8 字节 IV（CENC 约定），parseSenc 会把它补零成 16 字节。
const IV_SEEDS = [
  Buffer.from('0102030405060708', 'hex'),
  Buffer.from('1112131415161718', 'hex'),
  Buffer.from('2122232425262728', 'hex'),
]

const SAMPLE_SIZES = [64, 96, 32]
const FOREIGN_SAMPLE = Buffer.from('text-sample-14', 'ascii')

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value >>> 0, 0)
  return buffer
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(payload.length + 8, 0)
  header.write(type, 4, 'ascii')
  return Buffer.concat([header, payload])
}

function fullBox(type: string, body: Buffer): Buffer {
  return box(type, Buffer.concat([Buffer.alloc(4), body]))
}

function encryptSample(plain: Buffer, ivSeed: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ctr', KEY, Buffer.concat([ivSeed, Buffer.alloc(8)]))
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

/**
 * 合成一个最小 MP4：
 * - moov/trak/mdia/minf/stbl 下按真实顺序摆好 stsd(enca)/stsz/stsc/stco/senc
 * - mdat 里音频样本前可选地压着一个别的轨的样本（14 字节，复刻线上那首「孤岛」的形状）
 * - 两个 chunk：chunk0 两个样本、chunk1 一个样本，用来覆盖 stsc 的分段
 */
function buildFixture({ leadingForeignSample }: { leadingForeignSample: boolean }) {
  const plains = SAMPLE_SIZES.map((size, index) => Buffer.alloc(size, 0x40 + index))
  const ciphers = plains.map((plain, index) => encryptSample(plain, IV_SEEDS[index]))
  const audioBytes = Buffer.concat(ciphers)
  const mdatPayload = leadingForeignSample ? Buffer.concat([FOREIGN_SAMPLE, audioBytes]) : audioBytes
  const foreignBytes = leadingForeignSample ? FOREIGN_SAMPLE.length : 0
  const chunk0Bytes = SAMPLE_SIZES[0] + SAMPLE_SIZES[1]

  const buildStbl = (mdatOffset: number): Buffer => {
    const firstSampleOffset = mdatOffset + 8 + foreignBytes
    const chunkOffsets = [firstSampleOffset, firstSampleOffset + chunk0Bytes]
    const stsd = fullBox('stsd', Buffer.concat([u32(1), box('enca', Buffer.alloc(16))]))
    const stsz = fullBox('stsz', Buffer.concat([u32(0), u32(SAMPLE_SIZES.length), ...SAMPLE_SIZES.map(u32)]))
    const stsc = fullBox('stsc', Buffer.concat([u32(2), u32(1), u32(2), u32(1), u32(2), u32(1), u32(1)]))
    const stco = fullBox('stco', Buffer.concat([u32(chunkOffsets.length), ...chunkOffsets.map(u32)]))
    const senc = fullBox('senc', Buffer.concat([u32(IV_SEEDS.length), ...IV_SEEDS]))

    return box('stbl', Buffer.concat([stsd, stsz, stsc, stco, senc]))
  }

  const buildMoov = (mdatOffset: number): Buffer =>
    box('moov', box('trak', box('mdia', box('minf', buildStbl(mdatOffset)))))

  // stco 里的偏移依赖 mdat 的位置，而 mdat 的位置又依赖 moov 的大小；
  // stco 的字节数不随偏移变化，所以先用 0 量一次大小再回填。
  const mdatOffset = buildMoov(0).length
  const fixture = Buffer.concat([buildMoov(mdatOffset), box('mdat', mdatPayload)])

  return { fixture, plains, mdatOffset, firstAudioOffset: mdatOffset + 8 + foreignBytes }
}

describe('汽水音频解密器：按 stco/stsc/stsz 展开真实样本偏移', () => {
  it('mdat 里音频样本前面还压着别的轨样本时，仍按真实偏移解密（线上「孤岛」那类曲目）', () => {
    const { fixture, plains, mdatOffset, firstAudioOffset } = buildFixture({ leadingForeignSample: true })
    const result = new TrackDecryptor().decrypt({ encryptedBuffer: fixture, spadeA: KEY_HEX })

    expect(result.meta.sampleOffsetSource).toBe('stco')
    expect(result.meta.sampleCount).toBe(SAMPLE_SIZES.length)
    expect(result.meta.chunkCount).toBe(2)
    expect(result.meta.isFlac).toBe(false)
    expect(result.extension).toBe('.m4a')

    // 前置的 text 样本必须原样保留（被解密覆盖就会连同音频一起错位）
    const foreignStart = mdatOffset + 8
    expect(result.buffer.subarray(foreignStart, foreignStart + FOREIGN_SAMPLE.length).equals(FOREIGN_SAMPLE)).toBe(true)

    // 每个音频样本都必须从 firstAudioOffset 起按真实偏移解出明文
    let cursor = firstAudioOffset
    for (const plain of plains) {
      expect(result.buffer.subarray(cursor, cursor + plain.length).equals(plain)).toBe(true)
      cursor += plain.length
    }

    // 「从 mdat 数据区顺序读」会把 14 字节字幕样本当成第一个音频样本，
    // 这正是修复前 Chromium 报 PIPELINE_ERROR_DECODE 的原因。
    const sequentialFirst = result.buffer.subarray(foreignStart, foreignStart + plains[0].length)
    expect(sequentialFirst.equals(plains[0])).toBe(false)
  })

  it('mdat 里没有前置样本时（旧的顺序读恰好正确的形状）解密结果不变', () => {
    const { fixture, plains, firstAudioOffset } = buildFixture({ leadingForeignSample: false })
    const result = new TrackDecryptor().decrypt({ encryptedBuffer: fixture, spadeA: KEY_HEX })

    expect(result.meta.sampleOffsetSource).toBe('stco')
    expect(result.meta.chunkCount).toBe(2)

    let cursor = firstAudioOffset
    for (const plain of plains) {
      expect(result.buffer.subarray(cursor, cursor + plain.length).equals(plain)).toBe(true)
      cursor += plain.length
    }
  })

  it('把 enca 样本描述改成 mp4a', () => {
    const { fixture } = buildFixture({ leadingForeignSample: true })
    const result = new TrackDecryptor().decrypt({ encryptedBuffer: fixture, spadeA: KEY_HEX })

    expect(result.buffer.includes(Buffer.from('enca', 'ascii'))).toBe(false)
    expect(result.buffer.includes(Buffer.from('mp4a', 'ascii'))).toBe(true)
  })

  it('缺少 stco/co64 时不会崩，只是回落到顺序读', () => {
    const { fixture } = buildFixture({ leadingForeignSample: true })
    const stcoIndex = fixture.indexOf(Buffer.from('stco', 'ascii'))
    expect(stcoIndex).toBeGreaterThan(0)

    // 把 stco 改名成 stcx，让解密器找不到 chunk offset 表
    const crippled = Buffer.from(fixture)
    crippled.write('stcx', stcoIndex, 'ascii')
    const result = new TrackDecryptor().decrypt({ encryptedBuffer: crippled, spadeA: KEY_HEX })

    expect(result.meta.sampleOffsetSource).toBe('sequential')
    expect(result.buffer.length).toBe(fixture.length)
  })

  it('IV 数量与样本数不一致时仍然抛错', () => {
    const { fixture } = buildFixture({ leadingForeignSample: true })
    const sencIndex = fixture.indexOf(Buffer.from('senc', 'ascii'))
    const crippled = Buffer.from(fixture)
    // senc 的 count 字段在盒子头之后 4 字节（version/flags）的位置
    crippled.writeUInt32BE(2, sencIndex + 4 + 4)

    expect(() => new TrackDecryptor().decrypt({ encryptedBuffer: crippled, spadeA: KEY_HEX })).toThrow(
      /sample count 3 does not match iv count 2/,
    )
  })
})

describe('computeSampleOffsets / parseStco / parseCo64', () => {
  it('按 stsc 的分段展开每个 chunk 内每个样本的偏移', () => {
    const offsets = computeSampleOffsets({
      sampleSizes: [10, 20, 30],
      stscEntries: [
        { firstChunk: 1, samplesPerChunk: 2 },
        { firstChunk: 2, samplesPerChunk: 1 },
      ],
      chunkOffsets: [1000, 2000],
    })

    expect(offsets).toEqual([1000, 1010, 2000])
  })

  it('展开不出完整布局时返回空数组（由调用方回落到顺序读）', () => {
    expect(computeSampleOffsets({ sampleSizes: [], stscEntries: [], chunkOffsets: [] })).toEqual([])
    expect(computeSampleOffsets({ sampleSizes: [10], stscEntries: [], chunkOffsets: [] })).toEqual([])
    expect(
      computeSampleOffsets({
        sampleSizes: [10, 20],
        stscEntries: [{ firstChunk: 1, samplesPerChunk: 1 }],
        chunkOffsets: [1000],
      }),
    ).toEqual([])
    expect(
      computeSampleOffsets({
        sampleSizes: [10],
        stscEntries: [{ firstChunk: 1, samplesPerChunk: 0 }],
        chunkOffsets: [1000],
      }),
    ).toEqual([])
  })

  it('读取 stco / co64 的 chunk 偏移表', () => {
    const stcoPayload = Buffer.concat([Buffer.alloc(4), u32(2), u32(70000), u32(140000)])
    expect(parseStco(stcoPayload)).toEqual([70000, 140000])

    const co64Entry = Buffer.alloc(8)
    co64Entry.writeBigUInt64BE(BigInt(5_000_000_000), 0)
    const co64Payload = Buffer.concat([Buffer.alloc(4), u32(1), co64Entry])
    expect(parseCo64(co64Payload)).toEqual([5_000_000_000])
  })
})
