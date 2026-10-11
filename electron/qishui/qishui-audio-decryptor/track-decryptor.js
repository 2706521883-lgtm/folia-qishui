const { Mp4Box } = require('./mp4-box')
const {
  aesCtrDecrypt,
  computeSampleOffsets,
  decryptSpadeA,
  hexToBuffer,
  parseCo64,
  parseSenc,
  parseStco,
  parseStsc,
  parseStsz,
  replaceEncaWithMp4a,
  sanitizeFilenamePart,
  scanForFlacMetadata,
} = require('./decrypt-utils')

class TrackDecryptor {
  resolveKey(spadeA) {
    if (!spadeA) {
      throw new Error('spade_a is required for decryption.')
    }

    const isHex = /^[0-9a-fA-F]+$/.test(spadeA)
    const keyHex = isHex ? spadeA : decryptSpadeA(spadeA)

    if (!keyHex) {
      throw new Error('Failed to resolve decryption key from spade_a.')
    }

    return hexToBuffer(keyHex)
  }

  // stco/stsc 算出来的偏移只有在 M4A 内部真的自洽时才用（必须落在 mdat 里、
  // 有序且互不重叠）；否则退回旧的「从 mdat 起点顺序读」，避免反而更糟。
  areSampleOffsetsUsable(sampleOffsets, sampleSizes, mdat) {
    if (!Array.isArray(sampleOffsets) || sampleOffsets.length !== sampleSizes.length) {
      return false
    }

    const start = mdat.offset + 8
    const end = mdat.offset + mdat.size

    for (let index = 0; index < sampleOffsets.length; index += 1) {
      const offset = sampleOffsets[index]
      const size = sampleSizes[index]

      if (!Number.isInteger(offset) || offset < start || offset + size > end) {
        return false
      }

      if (index > 0 && offset < sampleOffsets[index - 1] + sampleSizes[index - 1]) {
        return false
      }
    }

    return true
  }

  decryptSampleList({ fileBuffer, key, sampleSizes, ivs, sampleOffsets, mdatOffset }) {
    const decryptedSamples = []
    const useRealOffsets = Array.isArray(sampleOffsets) && sampleOffsets.length === sampleSizes.length
    let sequentialOffset = mdatOffset + 8

    for (let index = 0; index < sampleSizes.length; index += 1) {
      const size = sampleSizes[index]
      const iv = ivs[index]

      if (!iv) {
        throw new Error(`Missing IV for sample ${index}.`)
      }

      const sampleOffset = useRealOffsets ? sampleOffsets[index] : sequentialOffset
      const encrypted = fileBuffer.subarray(sampleOffset, sampleOffset + size)
      decryptedSamples.push(aesCtrDecrypt(key, iv, encrypted))
      sequentialOffset += size
    }

    return decryptedSamples
  }

  buildFlacFile(flacMetadata, decryptedSamples) {
    const flacSignature = Buffer.from('fLaC')
    const metadataBody = flacMetadata.length > 4
      ? flacMetadata.subarray(4)
      : flacMetadata

    return Buffer.concat([flacSignature, metadataBody, ...decryptedSamples])
  }

  buildM4aFile(fileBuffer, decryptedSamples, mdat, stsd, sampleOffsets) {
    const output = Buffer.from(fileBuffer)
    const useRealOffsets = Array.isArray(sampleOffsets) && sampleOffsets.length === decryptedSamples.length
    let sequentialOffset = mdat.offset + 8

    for (let index = 0; index < decryptedSamples.length; index += 1) {
      const sample = decryptedSamples[index]
      const writeOffset = useRealOffsets ? sampleOffsets[index] : sequentialOffset
      sample.copy(output, writeOffset)
      sequentialOffset += sample.length
    }

    replaceEncaWithMp4a(output, stsd.offset, stsd.offset + stsd.size)
    return output
  }

  createFileName({ title, artist, extension }) {
    const safeTitle = sanitizeFilenamePart(title, 'track')
    const safeArtist = sanitizeFilenamePart(artist, 'unknown')
    return `${safeTitle} - ${safeArtist}${extension}`
  }

  decrypt({ encryptedBuffer, spadeA, media = {} }) {
    if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) {
      throw new Error('encryptedBuffer must be a non-empty Buffer.')
    }

    const key = this.resolveKey(spadeA)

    const moov = Mp4Box.findBox(encryptedBuffer, 'moov')
    if (moov.isEmpty()) {
      throw new Error("Decrypt failed: 'moov' atom not found.")
    }

    const trak = Mp4Box.findBox(encryptedBuffer, 'trak', moov.offset + 8, moov.offset + moov.size)
    const mdia = Mp4Box.findBox(encryptedBuffer, 'mdia', trak.offset + 8, trak.offset + trak.size)
    const minf = Mp4Box.findBox(encryptedBuffer, 'minf', mdia.offset + 8, mdia.offset + mdia.size)
    const stbl = Mp4Box.findBox(encryptedBuffer, 'stbl', minf.offset + 8, minf.offset + minf.size)
    const stsd = Mp4Box.findBox(encryptedBuffer, 'stsd', stbl.offset + 8, stbl.offset + stbl.size)
    const stsz = Mp4Box.findBox(encryptedBuffer, 'stsz', stbl.offset + 8, stbl.offset + stbl.size)
    const stsc = Mp4Box.findBox(encryptedBuffer, 'stsc', stbl.offset + 8, stbl.offset + stbl.size)
    const stco = Mp4Box.findBox(encryptedBuffer, 'stco', stbl.offset + 8, stbl.offset + stbl.size)
    const co64 = Mp4Box.findBox(encryptedBuffer, 'co64', stbl.offset + 8, stbl.offset + stbl.size)

    let senc = Mp4Box.findBox(encryptedBuffer, 'senc', moov.offset + 8, moov.offset + moov.size)
    if (senc.isEmpty()) {
      senc = Mp4Box.findBox(encryptedBuffer, 'senc', stbl.offset + 8, stbl.offset + stbl.size)
    }

    if (senc.isEmpty()) {
      throw new Error("Decrypt failed: 'senc' atom not found.")
    }

    const mdat = Mp4Box.findBox(encryptedBuffer, 'mdat')
    if (mdat.isEmpty()) {
      throw new Error("Decrypt failed: 'mdat' atom not found.")
    }

    const flacMetadata = scanForFlacMetadata(stsd.data)
    const isFlac = flacMetadata.length > 0

    const sampleSizes = parseStsz(stsz.data)
    const stscEntries = parseStsc(stsc.data)
    const ivs = parseSenc(senc.data)

    let chunkOffsets = []
    let sampleOffsetSource = 'sequential'

    if (!stco.isEmpty()) {
      chunkOffsets = parseStco(stco.data)
      sampleOffsetSource = 'stco'
    } else if (!co64.isEmpty()) {
      chunkOffsets = parseCo64(co64.data)
      sampleOffsetSource = 'co64'
    }

    const chunkCount = chunkOffsets.length

    // 关键修复：mdat 里可能还有别的轨的样本（例如 text 字幕）排在音频样本之前，
    // 「从 mdat 起点顺序读」会整体错位并把 AAC 解成垃圾。这里按 stco/stsc/stsz
    // 展开每个样本的真实偏移；算不出来或越界时才退回顺序读。
    const computedSampleOffsets = computeSampleOffsets({
      sampleSizes,
      stscEntries,
      chunkOffsets,
    })
    const sampleOffsets = this.areSampleOffsetsUsable(computedSampleOffsets, sampleSizes, mdat)
      ? computedSampleOffsets
      : null

    if (!sampleOffsets) {
      sampleOffsetSource = 'sequential'
    }

    if (sampleSizes.length !== ivs.length) {
      throw new Error(`Decrypt failed: sample count ${sampleSizes.length} does not match iv count ${ivs.length}.`)
    }

    const decryptedSamples = this.decryptSampleList({
      fileBuffer: encryptedBuffer,
      key,
      sampleSizes,
      ivs,
      sampleOffsets,
      mdatOffset: mdat.offset,
    })

    const outputBuffer = isFlac
      ? this.buildFlacFile(flacMetadata, decryptedSamples)
      : this.buildM4aFile(encryptedBuffer, decryptedSamples, mdat, stsd, sampleOffsets)

    const extension = isFlac ? '.flac' : '.m4a'

    return {
      buffer: outputBuffer,
      extension,
      fileName: this.createFileName({
        title: media.title,
        artist: media.artist,
        extension,
      }),
      meta: {
        isFlac,
        sampleCount: sampleSizes.length,
        chunkCount,
        sampleOffsetSource,
      },
    }
  }
}

module.exports = {
  TrackDecryptor,
}
